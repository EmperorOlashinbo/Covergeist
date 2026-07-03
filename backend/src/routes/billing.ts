import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { db } from '../db/client';
import { subscriptions } from '../db/schema';
import { authPreHandler } from '../middleware/auth';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

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
        let customerId: string | undefined;
        const [existingSub] = await db
          .select({ stripeCustomerId: subscriptions.stripeCustomerId })
          .from(subscriptions)
          .where(eq(subscriptions.userId, userId))
          .limit(1);

        if (existingSub) {
          customerId = existingSub.stripeCustomerId;
        } else {
          const existing = await stripe.customers.search({
            query: `metadata['clerk_id']:'${clerkId}'`,
            limit: 1,
          });
          if (existing.data.length > 0) {
            customerId = existing.data[0].id;
          } else {
            const customer = await stripe.customers.create({
              email,
              metadata: { clerk_id: clerkId },
            });
            customerId = customer.id;
          }
        }

        const session = await stripe.checkout.sessions.create({
          customer: customerId,
          mode: 'subscription',
          line_items: [{ price: priceId, quantity: 1 }],
          success_url:
            process.env.STRIPE_SUCCESS_URL ??
            'https://covergeist.dev/billing/success',
          cancel_url:
            process.env.STRIPE_CANCEL_URL ??
            'https://covergeist.dev/billing/cancel',
        });

        return reply.status(200).send({ url: session.url });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        fastify.log.error({ err }, `Stripe checkout failed: ${detail}`);
        return reply.status(500).send({ error: 'checkout_failed', detail });
      }
    },
  );
}
