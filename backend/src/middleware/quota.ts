import { and, count, desc, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db/client';
import { generationLog, subscriptions } from '../db/schema';

declare module 'fastify' {
  interface FastifyRequest {
    billingPeriodStart: string | undefined;
  }
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

  if (!sub || !['active', 'trialing'].includes(sub.status)) {
    await reply.status(403).send({ error: 'no_subscription' });
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
