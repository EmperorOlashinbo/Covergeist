import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { db } from '../db/client';
import { subscriptions, users } from '../db/schema';
import { authPreHandler } from '../middleware/auth';
import { upsertSubscription } from '../lib/subscriptionUpsert';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// Stripe v22 types omit current_period_* — use raw shape from the API response
interface StripeSubRaw {
  id: string;
  status: string;
  current_period_start: number;
  current_period_end: number;
  customer: string;
}

/** Resolves the user's email: JWT first, then Clerk REST API as fallback. */
async function resolveEmail(jwtEmail: string, clerkId: string): Promise<string> {
  if (jwtEmail) return jwtEmail;
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) return '';
  try {
    const resp = await fetch(`https://api.clerk.com/v1/users/${clerkId}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!resp.ok) return '';
    const data = (await resp.json()) as {
      email_addresses?: Array<{ email_address: string }>;
    };
    return data.email_addresses?.[0]?.email_address ?? '';
  } catch {
    return '';
  }
}

/** Finds an active Stripe subscription across ALL customers that match clerk_id or email. */
async function findActiveStripeSubscription(
  clerkId: string,
  email: string,
): Promise<StripeSubRaw | null> {
  // Collect candidate customer IDs from both lookup paths in parallel
  const [byMeta, byEmail] = await Promise.all([
    stripe.customers.search({ query: `metadata['clerk_id']:'${clerkId}'`, limit: 10 }),
    email ? stripe.customers.list({ email, limit: 10 }) : Promise.resolve({ data: [] }),
  ]);

  // Deduplicate customers
  const seen = new Set<string>();
  const candidates: Array<{ id: string }> = [];
  for (const c of [...byMeta.data, ...byEmail.data]) {
    if (!seen.has(c.id)) { seen.add(c.id); candidates.push(c); }
  }

  // Check each candidate for an active subscription
  for (const { id: customerId } of candidates) {
    const subs = await stripe.subscriptions.list({
      customer: customerId,
      status: 'active',
      limit: 1,
    });
    if (subs.data.length > 0) {
      const s = subs.data[0] as unknown as StripeSubRaw;
      return { ...s, customer: customerId };
    }
    // Also check trialing
    const trialing = await stripe.subscriptions.list({
      customer: customerId,
      status: 'trialing',
      limit: 1,
    });
    if (trialing.data.length > 0) {
      const s = trialing.data[0] as unknown as StripeSubRaw;
      return { ...s, customer: customerId };
    }
  }
  return null;
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
        .orderBy(desc(subscriptions.updatedAt))
        .limit(1);

      if (!sub) return { status: 'none', currentPeriodEnd: null };
      return { status: sub.status, currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null };
    },
  );

  // Sync from Stripe (fallback when webhook was missed)
  fastify.post(
    '/v1/subscription/sync',
    { preHandler: authPreHandler },
    async (request, reply) => {
      const { clerkId, email: jwtEmail, userId } = request.user;

      fastify.log.info({ clerkId, jwtEmail, userId }, 'subscription/sync: starting');

      // ── Step 1: fast DB check ────────────────────────────────────────────
      const [existingSub] = await db
        .select({ stripeCustomerId: subscriptions.stripeCustomerId, status: subscriptions.status })
        .from(subscriptions)
        .where(eq(subscriptions.userId, userId))
        .orderBy(desc(subscriptions.updatedAt))
        .limit(1);

      if (existingSub && ['active', 'trialing'].includes(existingSub.status)) {
        fastify.log.info({ status: existingSub.status }, 'subscription/sync: found active sub in DB');
        return reply.send({ status: existingSub.status, currentPeriodEnd: null });
      }

      // ── Step 2: resolve email (JWT may omit it; fall back to Clerk API) ──
      const email = await resolveEmail(jwtEmail, clerkId);
      fastify.log.info({ clerkId, email, jwtEmail }, 'subscription/sync: resolved email');

      // ── Step 3: find active Stripe subscription across all matching customers
      const s = await findActiveStripeSubscription(clerkId, email);

      if (!s) {
        fastify.log.info({ clerkId, email }, 'subscription/sync: no active Stripe subscription found');
        return reply.send({ status: 'none', currentPeriodEnd: null });
      }

      fastify.log.info(
        { subscriptionId: s.id, customerId: s.customer, status: s.status },
        'subscription/sync: found active Stripe subscription',
      );

      const periodStart = new Date(s.current_period_start * 1000).toISOString().split('T')[0]!;
      const periodEnd = new Date(s.current_period_end * 1000);

      // Ensure the customer has clerk_id in metadata for future lookups
      await stripe.customers.update(s.customer, {
        metadata: { clerk_id: clerkId },
      }).catch(() => { /* non-fatal */ });

      // ── Step 4: find our DB user ─────────────────────────────────────────
      let resolvedUserId = userId;
      if (!existingSub) {
        const [u] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.clerkId, clerkId))
          .limit(1);
        if (u) resolvedUserId = u.id;
      }

      // ── Step 5: upsert to DB ─────────────────────────────────────────────
      try {
        await upsertSubscription({
          userId: resolvedUserId,
          stripeCustomerId: s.customer,
          stripeSubscriptionId: s.id,
          status: s.status,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
        });
        fastify.log.info(
          { subscriptionId: s.id, resolvedUserId, status: s.status },
          'subscription/sync: DB upsert succeeded',
        );
      } catch (dbErr) {
        fastify.log.error({ dbErr, subscriptionId: s.id }, 'subscription/sync: DB upsert FAILED');
        return reply.send({
          status: s.status,
          currentPeriodEnd: periodEnd.toISOString(),
          _dbError: dbErr instanceof Error ? dbErr.message : String(dbErr),
        });
      }

      return reply.send({ status: s.status, currentPeriodEnd: periodEnd.toISOString() });
    },
  );

  // Diagnostic endpoint — shows exactly what sync would find (safe, read-only)
  fastify.get(
    '/v1/debug/subscription',
    { preHandler: authPreHandler },
    async (request) => {
      const { clerkId, email: jwtEmail, userId } = request.user;

      const [dbSub] = await db
        .select({
          status: subscriptions.status,
          stripeCustomerId: subscriptions.stripeCustomerId,
          stripeSubscriptionId: subscriptions.stripeSubscriptionId,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
        })
        .from(subscriptions)
        .where(eq(subscriptions.userId, userId))
        .orderBy(desc(subscriptions.updatedAt))
        .limit(1);

      const email = await resolveEmail(jwtEmail, clerkId);

      let byMeta: Array<{ id: string; email: string | null }> = [];
      let byEmailResult: Array<{ id: string; email: string | null }> = [];
      let activeStripeSubId: string | null = null;
      let activeStripeStatus: string | null = null;
      let stripeError: string | null = null;

      try {
        const [metaRes, emailRes] = await Promise.all([
          stripe.customers.search({ query: `metadata['clerk_id']:'${clerkId}'`, limit: 5 }),
          email ? stripe.customers.list({ email, limit: 5 }) : Promise.resolve({ data: [] }),
        ]);
        byMeta = metaRes.data.map(c => ({ id: c.id, email: c.email ?? null }));
        byEmailResult = emailRes.data.map(c => ({ id: c.id, email: c.email ?? null }));

        const activeSub = await findActiveStripeSubscription(clerkId, email);
        if (activeSub) {
          activeStripeSubId = activeSub.id;
          activeStripeStatus = activeSub.status;
        }
      } catch (e) {
        stripeError = e instanceof Error ? e.message : String(e);
      }

      return {
        clerkId,
        jwtEmail,
        resolvedEmail: email,
        userId,
        dbSubscription: dbSub ?? null,
        stripeCustomersByMeta: byMeta,
        stripeCustomersByEmail: byEmailResult,
        activeStripeSubscriptionId: activeStripeSubId,
        activeStripeStatus,
        stripeError,
      };
    },
  );
}
