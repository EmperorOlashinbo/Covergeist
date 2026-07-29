import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { db } from '../db/client';
import { subscriptions } from '../db/schema';
import { upsertSubscription } from '../lib/subscriptionUpsert';
import { authPreHandler } from '../middleware/auth';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

interface ActiveSubResult {
  customerId: string;
  subscriptionId: string;
  status: string;
  periodStart: number;
  periodEnd: number;
}

/** Returns the first active/trialing Stripe subscription for this clerk user, or null. */
async function findExistingActiveSub(clerkId: string): Promise<ActiveSubResult | null> {
  const customers = await stripe.customers.search({
    query: `metadata['clerk_id']:'${clerkId}'`,
    limit: 10,
  });
  for (const customer of customers.data) {
    for (const status of ['active', 'trialing'] as const) {
      const subs = await stripe.subscriptions.list({ customer: customer.id, status, limit: 1 });
      if (subs.data.length > 0) {
        const s = subs.data[0] as unknown as {
          id: string; status: string;
          current_period_start: number; current_period_end: number;
        };
        return {
          customerId: customer.id,
          subscriptionId: s.id,
          status: s.status,
          periodStart: s.current_period_start,
          periodEnd: s.current_period_end,
        };
      }
    }
  }
  return null;
}

export async function billingRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/v1/billing/checkout',
    { preHandler: authPreHandler },
    async (request, reply) => {
      const priceId = process.env.STRIPE_PRICE_ID;
      if (!priceId) {
        return reply.status(500).send({
          error: 'billing_not_configured',
          detail: 'STRIPE_PRICE_ID is not set on the server.',
        });
      }

      const { clerkId, email, userId } = request.user;

      try {
        // ── Guard: prevent duplicate subscriptions ──────────────────────────
        // Check DB first (fast path), then Stripe (authoritative).
        const [dbSub] = await db
          .select({ status: subscriptions.status, stripeCustomerId: subscriptions.stripeCustomerId })
          .from(subscriptions)
          .where(eq(subscriptions.userId, userId))
          .orderBy(desc(subscriptions.updatedAt))
          .limit(1);

        if (dbSub && ['active', 'trialing'].includes(dbSub.status)) {
          fastify.log.info({ userId }, 'billing/checkout: user already subscribed (DB hit)');
          return reply.status(200).send({ url: null, alreadySubscribed: true });
        }

        // DB doesn't have an active sub — check Stripe directly
        const existingActiveSub = await findExistingActiveSub(clerkId);
        if (existingActiveSub) {
          // Write to DB so future requests skip Stripe entirely
          const periodStart = new Date(existingActiveSub.periodStart * 1000).toISOString().split('T')[0]!;
          const periodEnd = new Date(existingActiveSub.periodEnd * 1000);
          await upsertSubscription({
            userId,
            stripeCustomerId: existingActiveSub.customerId,
            stripeSubscriptionId: existingActiveSub.subscriptionId,
            status: existingActiveSub.status,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
          }).catch(e => fastify.log.error({ e }, 'billing/checkout: DB write failed on already-subscribed path'));
          fastify.log.info({ userId, subscriptionId: existingActiveSub.subscriptionId }, 'billing/checkout: existing active sub found, returning alreadySubscribed');
          return reply.status(200).send({ url: null, alreadySubscribed: true });
        }

        // ── No active sub — create checkout session ─────────────────────────
        const existing = await stripe.customers.search({
          query: `metadata['clerk_id']:'${clerkId}'`,
          limit: 1,
        });
        let customerId: string;
        if (existing.data.length > 0) {
          customerId = existing.data[0].id;
        } else {
          const customer = await stripe.customers.create({
            email: email || undefined,
            metadata: { clerk_id: clerkId },
          });
          customerId = customer.id;
        }

        const session = await stripe.checkout.sessions.create({
          customer: customerId,
          mode: 'subscription',
          line_items: [{ price: priceId, quantity: 1 }],
          metadata: { clerk_id: clerkId, user_id: userId },
          success_url:
            process.env.STRIPE_SUCCESS_URL ??
            'https://covergeist.dev/billing/success',
          cancel_url:
            process.env.STRIPE_CANCEL_URL ??
            'https://covergeist.dev/billing/cancel',
        });

        return reply.status(200).send({ url: session.url, alreadySubscribed: false });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        fastify.log.error({ err }, `Stripe checkout failed: ${detail}`);
        return reply.status(500).send({ error: 'checkout_failed', detail });
      }
    },
  );
}
