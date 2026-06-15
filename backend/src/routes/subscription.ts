import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import { subscriptions } from '../db/schema';
import { authPreHandler } from '../middleware/auth';

export async function subscriptionRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/v1/subscription',
    { preHandler: authPreHandler },
    async request => {
      const [sub] = await db
        .select({
          status: subscriptions.status,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
        })
        .from(subscriptions)
        .where(eq(subscriptions.userId, request.user.userId))
        .limit(1);

      if (!sub) {
        return { status: 'none', currentPeriodEnd: null };
      }

      return {
        status: sub.status,
        currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
      };
    },
  );
}
