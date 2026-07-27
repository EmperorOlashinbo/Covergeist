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

  // Sync from Stripe (fallback when webhook missed)
  fastify.post(
    '/v1/subscription/sync',
    { preHandler: authPreHandler },
    async (request, reply) => {
      const { clerkId, userId } = request.user;

      // Find the Stripe customer — first check our DB, then search Stripe
      let customerId: string | undefined;
      const [existingSub] = await db
        .select({ stripeCustomerId: subscriptions.stripeCustomerId })
        .from(subscriptions)
        .where(eq(subscriptions.userId, userId))
        .limit(1);

      if (existingSub) {
        customerId = existingSub.stripeCustomerId;
      } else {
        const found = await stripe.customers.search({
          query: `metadata['clerk_id']:'${clerkId}'`,
          limit: 1,
        });
        if (found.data.length === 0) {
          return reply.send({ status: 'none', currentPeriodEnd: null });
        }
        customerId = found.data[0].id;
      }

      // Query Stripe directly for any active/trialing subscription
      const stripeSubs = await stripe.subscriptions.list({
        customer: customerId,
        status: 'active',
        limit: 1,
      });

      if (stripeSubs.data.length === 0) {
        return reply.send({ status: 'none', currentPeriodEnd: null });
      }

      const s = stripeSubs.data[0] as unknown as StripeSubRaw;
      const periodStart = new Date(s.current_period_start * 1000).toISOString().split('T')[0]!;
      const periodEnd = new Date(s.current_period_end * 1000);

      // Find the user if we don't have the userId yet (customer found via Stripe search)
      let resolvedUserId = userId;
      if (!existingSub) {
        const customer = await stripe.customers.retrieve(customerId);
        if (!('deleted' in customer)) {
          const ckId = customer.metadata?.clerk_id;
          if (ckId) {
            const [u] = await db.select({ id: users.id }).from(users).where(eq(users.clerkId, ckId)).limit(1);
            if (u) resolvedUserId = u.id;
          }
        }
      }

      // Upsert subscription record so future DB checks work without Stripe
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

      return reply.send({ status: s.status, currentPeriodEnd: periodEnd.toISOString() });
    },
  );
}
