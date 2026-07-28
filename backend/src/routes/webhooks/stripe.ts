import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { db } from '../../db/client';
import { subscriptions, users } from '../../db/schema';
import { upsertSubscription } from '../../lib/subscriptionUpsert';

interface CheckoutSessionData {
  id: string;
  customer: string | null;
  subscription: string | null;
  metadata: Record<string, string> | null;
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// In Stripe v22 the namespace types aren't forwarded through the CJS default export;
// derive what we need from the instance method return types.
type StripeEvent = ReturnType<typeof stripe.webhooks.constructEvent>;

interface SubData {
  id: string;
  customer: string | object;
  status: string;
  current_period_start: number;
  current_period_end: number;
}

interface InvoiceData {
  subscription: string | object | null;
}

export async function stripeWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  // Raw body required for Stripe signature verification — scoped to this plugin only
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  fastify.post('/v1/webhooks/stripe', async (request, reply) => {
    const sig = request.headers['stripe-signature'];
    if (!sig || typeof sig !== 'string') {
      return reply.status(400).send({ error: 'missing_signature' });
    }

    let event: StripeEvent;
    try {
      event = stripe.webhooks.constructEvent(
        request.body as Buffer,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET!,
      );
    } catch {
      return reply.status(400).send({ error: 'invalid_signature' });
    }

    switch (event.type) {
      // checkout.session.completed fires immediately after successful payment.
      // The session carries clerk_id + user_id in metadata so we can write to
      // DB without any additional Stripe lookup.
      case 'checkout.session.completed':
        await handleCheckoutComplete(
          fastify,
          event.data.object as unknown as CheckoutSessionData,
        );
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpsert(fastify, event.data.object as unknown as SubData);
        break;

      case 'customer.subscription.deleted': {
        const sub = event.data.object as unknown as SubData;
        await db
          .update(subscriptions)
          .set({ status: 'canceled', updatedAt: new Date() })
          .where(eq(subscriptions.stripeSubscriptionId, sub.id));
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as unknown as InvoiceData;
        const subId =
          typeof invoice.subscription === 'string' ? invoice.subscription : null;
        if (subId) {
          await db
            .update(subscriptions)
            .set({ status: 'past_due', updatedAt: new Date() })
            .where(eq(subscriptions.stripeSubscriptionId, subId));
        }
        break;
      }

      default:
        // Return 200 for all unrecognised event types (Stripe requires fast ACK)
    }

    return reply.status(200).send({ received: true });
  });
}

async function handleCheckoutComplete(
  fastify: FastifyInstance,
  session: CheckoutSessionData,
): Promise<void> {
  const subscriptionId = session.subscription;
  const customerId = session.customer;
  if (!subscriptionId || !customerId) return;

  const clerkId = session.metadata?.clerk_id;
  const userDbId = session.metadata?.user_id;

  // Resolve user: prefer the user_id from session metadata, fall back to clerk_id lookup
  let resolvedUserId: string | undefined = userDbId ?? undefined;
  if (!resolvedUserId && clerkId) {
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clerkId, clerkId))
      .limit(1);
    resolvedUserId = u?.id;
  }

  if (!resolvedUserId) {
    fastify.log.warn(
      { subscriptionId, customerId, clerkId },
      'checkout.session.completed: cannot resolve userId — subscription not written',
    );
    return;
  }

  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const subRaw = sub as unknown as SubData;
  const periodStart = new Date(subRaw.current_period_start * 1000).toISOString().split('T')[0]!;
  const periodEnd = new Date(subRaw.current_period_end * 1000);

  await upsertSubscription({
    userId: resolvedUserId,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    status: sub.status,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
  });

  fastify.log.info(
    { subscriptionId, resolvedUserId, status: sub.status },
    'checkout.session.completed: subscription written to DB',
  );
}

async function handleSubscriptionUpsert(
  fastify: FastifyInstance,
  sub: SubData,
): Promise<void> {
  const customerId = sub.customer as string;
  const periodStart = new Date(sub.current_period_start * 1000)
    .toISOString()
    .split('T')[0]!;
  const periodEnd = new Date(sub.current_period_end * 1000);

  // Try to update an existing row first (match by subscription ID)
  const updated = await db
    .update(subscriptions)
    .set({
      status: sub.status,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.stripeSubscriptionId, sub.id))
    .returning({ id: subscriptions.id });

  if (updated.length > 0) {
    fastify.log.info({ subscriptionId: sub.id, status: sub.status }, 'webhook: subscription updated');
    return;
  }

  // No existing row — look up the user via Stripe customer metadata (clerk_id)
  const customer = await stripe.customers.retrieve(customerId);
  if ('deleted' in customer) return;

  const clerkId = customer.metadata?.clerk_id;
  if (!clerkId) {
    fastify.log.warn(
      { customerId, subscriptionId: sub.id },
      'webhook: customer has no clerk_id metadata — cannot link subscription',
    );
    return;
  }

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);

  if (!user) {
    fastify.log.warn({ clerkId }, 'webhook: no user found for clerkId');
    return;
  }

  await upsertSubscription({
    userId: user.id,
    stripeCustomerId: customerId,
    stripeSubscriptionId: sub.id,
    status: sub.status,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
  });

  fastify.log.info(
    { subscriptionId: sub.id, userId: user.id, status: sub.status },
    'webhook: subscription inserted',
  );
}
