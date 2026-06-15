import { and, count, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import { generationLog, subscriptions } from '../db/schema';
import { authPreHandler } from '../middleware/auth';

export async function quotaRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/v1/quota',
    { preHandler: authPreHandler },
    async (request, reply) => {
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
        return reply.status(403).send({ error: 'no_subscription' });
      }

      let used = 0;
      if (sub.currentPeriodStart) {
        const [result] = await db
          .select({ count: count() })
          .from(generationLog)
          .where(
            and(
              eq(generationLog.userId, request.user.userId),
              eq(generationLog.billingPeriodStart, sub.currentPeriodStart),
            ),
          );
        used = Number(result?.count ?? 0);
      }

      return {
        used,
        limit: sub.generationsLimit,
        resetAt: sub.currentPeriodEnd?.toISOString() ?? new Date().toISOString(),
      };
    },
  );
}
