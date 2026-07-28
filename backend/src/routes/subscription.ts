import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { db } from '../db/client';
import { subscriptions, users } from '../db/schema';
import { authPreHandler } from '../middleware/auth';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// Stripe v22 types omit current_period_* — use raw shape from the API response
interface StripeSubRaw {
  id: string;
  status: string;
  current_period_start: number;
  current_period_end: number;
}

export async function subscriptionRoutes(fastify: FastifyInstance): Promise<void> {
  // Read from DB (fast path)
  fastify.get(
    '/v1/subscription',
    { preHandler: authPreHandler },
    async request => {
      const [sub] = await db
        .select({ status: subscriptions.status, currentPeriodEnd: subscriptions.currentPeriodEnd })
        .from(subscriptions)
        .where(eq(subscriptions.userId, request.user.userId))
        .limit(1);

      if (!sub) return { status: 'none', currentPeriodEnd: null };
      return { status: sub.status, currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null };
    },
  );

  // Sync from Stripe (fallback when webhook was missed or customer has no clerk_id metadata)
  fastify.post(
    '/v1/subscription/sync',
    { preHandler: authPreHandler },
    async (request, reply) => {
      const { clerkId, email, userId } = request.user;

      // ── Step 1: find the Stripe customer ──────────────────────────────────
      let customerId: string | undefined;

      // 1a. Check our own DB first
      const [existingSub] = await db
        .select({ stripeCustomerId: subscriptions.stripeCustomerId })
        .from(subscriptions)
        .where(eq(subscriptions.userId, userId))
        .limit(1);

      if (existingSub) {
        customerId = existingSub.stripeCustomerId;
      }

      // 1b. Search Stripe by clerk_id metadata
      if (!customerId) {
        const byMeta = await stripe.customers.search({
          query: `metadata['clerk_id']:'${clerkId}'`,
          limit: 1,
        });
        if (byMeta.data.length > 0) customerId = byMeta.data[0].id;
      }

      // 1c. Fallback: search by email and pick the customer that has an active sub
      if (!customerId && email) {
        const byEmail = await stripe.customers.list({ email, limit: 10 });
        for (const customer of byEmail.data) {
          const subs = await stripe.subscriptions.list({
            customer: customer.id,
            status: 'active',
            limit: 1,
          });
          if (subs.data.length > 0) {
            customerId = customer.id;
            // Write clerk_id into metadata so future lookups by metadata work
            await stripe.customers.update(customer.id, {
              metadata: { clerk_id: clerkId },
            });
            break;
          }
        }
      }

      if (!customerId) {
        fastify.log.info({ clerkId, email }, 'subscription/sync: no Stripe customer found');
        return reply.send({ status: 'none', currentPeriodEnd: null });
      }

      // ── Step 2: get the active subscription for that customer ─────────────
      const stripeSubs = await stripe.subscriptions.list({
        customer: customerId,
        status: 'active',
        limit: 1,
      });

      if (stripeSubs.data.length === 0) {
        fastify.log.info({ customerId }, 'subscription/sync: customer has no active subscription');
        return reply.send({ status: 'none', currentPeriodEnd: null });
      }

      const s = stripeSubs.data[0] as unknown as StripeSubRaw;
      const periodStart = new Date(s.current_period_start * 1000).toISOString().split('T')[0]!;
      const periodEnd = new Date(s.current_period_end * 1000);

      // Resolve userId in case we found the customer via email (not our DB)
      let resolvedUserId = userId;
      if (!existingSub) {
        const [u] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.clerkId, clerkId))
          .limit(1);
        if (u) resolvedUserId = u.id;
      }

      // ── Step 3: upsert so DB is correct for future requests ───────────────
      await db
        .insert(subscriptions)
        .values({
          userId: resolvedUserId,
          stripeCustomerId: customerId,
          stripeSubscriptionId: s.id,
          status: s.status,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
        })
        .onConflictDoUpdate({
          target: subscriptions.stripeCustomerId,
          set: {
            status: s.status,
            stripeSubscriptionId: s.id,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            updatedAt: new Date(),
          },
        });

      fastify.log.info({ customerId, status: s.status }, 'subscription/sync: synced successfully');
      return reply.send({ status: s.status, currentPeriodEnd: periodEnd.toISOString() });
    },
  );
}
