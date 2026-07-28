import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { subscriptions } from '../db/schema';

interface UpsertArgs {
  userId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd: Date;
}

/**
 * Writes a subscription row without using ON CONFLICT, so it works even if
 * the stripe_subscription_id unique constraint is missing in the production DB.
 *
 * Uses SELECT-then-INSERT-or-UPDATE. Acceptable for our single-user-at-a-time
 * flow where concurrent duplicate writes are not a concern.
 */
export async function upsertSubscription(args: UpsertArgs): Promise<void> {
  const { userId, stripeCustomerId, stripeSubscriptionId, status, currentPeriodStart, currentPeriodEnd } = args;

  const [existing] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId))
    .limit(1);

  if (existing) {
    await db
      .update(subscriptions)
      .set({ userId, status, currentPeriodStart, currentPeriodEnd, updatedAt: new Date() })
      .where(eq(subscriptions.id, existing.id));
  } else {
    await db.insert(subscriptions).values({
      userId,
      stripeCustomerId,
      stripeSubscriptionId,
      status,
      currentPeriodStart,
      currentPeriodEnd,
    });
  }
}
