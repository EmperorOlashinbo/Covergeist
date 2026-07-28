import { and, count, desc, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import Stripe from 'stripe';
import { db } from '../db/client';
import { generationLog, subscriptions, users } from '../db/schema';
import { upsertSubscription } from '../lib/subscriptionUpsert';

declare module 'fastify' {
  interface FastifyRequest {
    billingPeriodStart: string | undefined;
  }
}

interface StripeSubRaw {
  id: string;
  status: string;
  customer: string;
  current_period_start: number;
  current_period_end: number;
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

/** Searches Stripe for any active/trialing subscription for the given clerkId. */
async function findStripeSubForUser(clerkId: string): Promise<StripeSubRaw | null> {
  const customers = await stripe.customers.search({
    query: `metadata['clerk_id']:'${clerkId}'`,
    limit: 10,
  });

  for (const customer of customers.data) {
    for (const status of ['active', 'trialing'] as const) {
      const subs = await stripe.subscriptions.list({
        customer: customer.id,
        status,
        limit: 1,
      });
      if (subs.data.length > 0) {
        return { ...(subs.data[0] as unknown as StripeSubRaw), customer: customer.id };
      }
    }
  }
  return null;
}

export async function quotaPreHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const [sub] = await db
    .select({
      status: subscriptions.status,
      currentPeriodStart: subscriptions.currentPeriodStart,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      generationsLimit: subscriptions.generationsLimit,
    })
    .from(subscriptions)
    .where(eq(subscriptions.userId, request.user.userId))
    .orderBy(desc(subscriptions.updatedAt))
    .limit(1);

  // No active DB subscription — fall back to a direct Stripe check before rejecting.
  // This handles the case where sync found a subscription but the DB write failed.
  if (!sub || !['active', 'trialing'].includes(sub.status)) {
    let stripeSub: StripeSubRaw | null = null;
    try {
      stripeSub = await findStripeSubForUser(request.user.clerkId);
    } catch { /* ignore Stripe errors — 403 below is the safe default */ }

    if (!stripeSub) {
      await reply.status(403).send({ error: 'no_subscription' });
      return;
    }

    // Write to DB so future requests don't need the Stripe fallback
    const periodStart = new Date(stripeSub.current_period_start * 1000).toISOString().split('T')[0]!;
    const periodEnd = new Date(stripeSub.current_period_end * 1000);

    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clerkId, request.user.clerkId))
      .limit(1);

    if (u) {
      await upsertSubscription({
        userId: u.id,
        stripeCustomerId: stripeSub.customer,
        stripeSubscriptionId: stripeSub.id,
        status: stripeSub.status,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      }).catch(() => { /* non-fatal — generation proceeds even if write fails */ });
    }

    // Allow the request through using the Stripe subscription's billing period
    request.billingPeriodStart = periodStart;
    return;
  }

  if (!sub.currentPeriodStart) {
    // Billing period not yet set — allow through without counting
    return;
  }

  const [result] = await db
    .select({ count: count() })
    .from(generationLog)
    .where(
      and(
        eq(generationLog.userId, request.user.userId),
        eq(generationLog.billingPeriodStart, sub.currentPeriodStart),
      ),
    );

  const used = Number(result?.count ?? 0);

  if (used >= sub.generationsLimit) {
    await reply.status(402).send({
      error: 'quota_exceeded',
      remaining: 0,
      resetAt: sub.currentPeriodEnd?.toISOString() ?? new Date().toISOString(),
    });
    return;
  }

  // Pass the billing period to the route handler for generation_log insertion
  request.billingPeriodStart = sub.currentPeriodStart;
}
