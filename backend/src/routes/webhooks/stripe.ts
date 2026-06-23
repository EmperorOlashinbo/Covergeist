import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { db } from '../../db/client';
import { subscriptions, users } from '../../db/schema';

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
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpsert(event.data.object as unknown as SubData);
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

async function handleSubscriptionUpsert(sub: SubData): Promise<void> {
  const customerId = sub.customer as string;
  const periodStart = new Date(sub.current_period_start * 1000)
    .toISOString()
    .split('T')[0]!;
  const periodEnd = new Date(sub.current_period_end * 1000);

  // Try to update an existing row first
  const updated = await db
    .update(subscriptions)
    .set({
      status: sub.status,
      stripeSubscriptionId: sub.id,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.stripeCustomerId, customerId))
    .returning({ id: subscriptions.id });

  if (updated.length > 0) return;

  // No existing row — look up the user via Stripe customer metadata (clerk_id)
  // The billing checkout flow stores clerk_id in customer.metadata when creating
  // the Stripe customer.
  const customer = await stripe.customers.retrieve(customerId);
  if ('deleted' in customer) return;

  const clerkId = customer.metadata?.clerk_id;
  if (!clerkId) return;

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);

  if (!user) return;

  await db
    .insert(subscriptions)
    .values({
      userId: user.id,
      stripeCustomerId: customerId,
      stripeSubscriptionId: sub.id,
      status: sub.status,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
    })
    .onConflictDoUpdate({
      target: subscriptions.stripeCustomerId,
      set: {
        status: sub.status,
        stripeSubscriptionId: sub.id,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        updatedAt: new Date(),
      },
    });
}
