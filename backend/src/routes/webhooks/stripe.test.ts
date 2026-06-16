import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder';
});

// vi.hoisted creates the spy fns before vi.mock factories run and before
// stripe.ts imports Stripe, so `const stripe = new Stripe(...)` at module
// level gets the mock class.
const { mockConstructEvent, mockCustomersRetrieve } = vi.hoisted(() => ({
  mockConstructEvent: vi.fn(),
  mockCustomersRetrieve: vi.fn(),
}));

vi.mock('stripe', () => ({
  default: class MockStripe {
    webhooks = { constructEvent: mockConstructEvent };
    customers = { retrieve: mockCustomersRetrieve };
  },
}));

vi.mock('../../db/client', () => ({
  db: { update: vi.fn(), insert: vi.fn(), select: vi.fn() },
}));
vi.mock('../../db/schema', () => ({ subscriptions: {}, users: {} }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(), and: vi.fn(), desc: vi.fn(), count: vi.fn() }));

import Fastify from 'fastify';
import { db } from '../../db/client';
import { stripeWebhookRoutes } from './stripe';

function buildApp() {
  const app = Fastify();
  void app.register(stripeWebhookRoutes);
  return app;
}

function updateChain(returning: unknown[] = [{ id: 'sub-1' }]) {
  const c = {
    set: () => c,
    where: () => ({ returning: () => Promise.resolve(returning) }),
  };
  return c as ReturnType<typeof db.update>;
}

function insertChain() {
  return {
    values: () => ({ onConflictDoUpdate: () => Promise.resolve() }),
  } as ReturnType<typeof db.insert>;
}

function selectChain(rows: unknown[]) {
  const c: Record<string, unknown> = {
    from: () => c,
    where: () => c,
    limit: () => Promise.resolve(rows),
  };
  return c as ReturnType<typeof db.select>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.update).mockReturnValue(updateChain());
  vi.mocked(db.insert).mockReturnValue(insertChain());
  vi.mocked(db.select).mockReturnValue(selectChain([{ id: 'user-uuid' }]));
});

describe('POST /v1/webhooks/stripe', () => {
  it('returns 400 when stripe-signature header is missing', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      payload: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'missing_signature' });
  });

  it('returns 400 when signature verification fails', async () => {
    mockConstructEvent.mockImplementation(() => { throw new Error('bad sig'); });
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      payload: '{}',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_signature' });
  });

  it('returns 200 and updates subscription on customer.subscription.updated', async () => {
    const subData = {
      id: 'sub_123', customer: 'cus_abc', status: 'active',
      current_period_start: 1748736000, current_period_end: 1751414400,
    };
    mockConstructEvent.mockReturnValue({ type: 'customer.subscription.updated', data: { object: subData } });

    const app = buildApp();
    const res = await app.inject({
      method: 'POST', url: '/v1/webhooks/stripe',
      payload: JSON.stringify(subData),
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ received: true });
    expect(db.update).toHaveBeenCalled();
  });

  it('sets status to canceled on customer.subscription.deleted', async () => {
    mockConstructEvent.mockReturnValue({
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_123' } },
    });
    const app = buildApp();
    const res = await app.inject({
      method: 'POST', url: '/v1/webhooks/stripe',
      payload: '{}',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig' },
    });
    expect(res.statusCode).toBe(200);
    expect(db.update).toHaveBeenCalled();
  });

  it('sets status to past_due on invoice.payment_failed', async () => {
    mockConstructEvent.mockReturnValue({
      type: 'invoice.payment_failed',
      data: { object: { subscription: 'sub_123' } },
    });
    const app = buildApp();
    const res = await app.inject({
      method: 'POST', url: '/v1/webhooks/stripe',
      payload: '{}',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig' },
    });
    expect(res.statusCode).toBe(200);
    expect(db.update).toHaveBeenCalled();
  });

  it('returns 200 for unrecognised event types without side effects', async () => {
    mockConstructEvent.mockReturnValue({ type: 'some.unknown.event', data: { object: {} } });
    const app = buildApp();
    const res = await app.inject({
      method: 'POST', url: '/v1/webhooks/stripe',
      payload: '{}',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig' },
    });
    expect(res.statusCode).toBe(200);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('skips invoice.payment_failed when subscription is not a string', async () => {
    mockConstructEvent.mockReturnValue({
      type: 'invoice.payment_failed',
      data: { object: { subscription: null } },
    });
    const app = buildApp();
    await app.inject({
      method: 'POST', url: '/v1/webhooks/stripe',
      payload: '{}',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig' },
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('falls back to customer lookup and inserts when no subscription row exists', async () => {
    const subData = {
      id: 'sub_new', customer: 'cus_new', status: 'active',
      current_period_start: 1748736000, current_period_end: 1751414400,
    };
    mockConstructEvent.mockReturnValue({ type: 'customer.subscription.updated', data: { object: subData } });
    // update returns empty → triggers customer lookup fallback
    vi.mocked(db.update).mockReturnValue(updateChain([]));
    mockCustomersRetrieve.mockResolvedValue({ id: 'cus_new', metadata: { clerk_id: 'clerk-xyz' } });

    const app = buildApp();
    const res = await app.inject({
      method: 'POST', url: '/v1/webhooks/stripe',
      payload: JSON.stringify(subData),
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig' },
    });
    expect(res.statusCode).toBe(200);
    expect(mockCustomersRetrieve).toHaveBeenCalledWith('cus_new');
    expect(db.insert).toHaveBeenCalled();
  });
});
