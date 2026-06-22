import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder';
  process.env.STRIPE_PRICE_ID = 'price_test123';
});

const { mockCustomersSearch, mockCustomersCreate, mockSessionsCreate } = vi.hoisted(() => ({
  mockCustomersSearch: vi.fn(),
  mockCustomersCreate: vi.fn(),
  mockSessionsCreate: vi.fn(),
}));

vi.mock('stripe', () => ({
  default: class MockStripe {
    customers = { search: mockCustomersSearch, create: mockCustomersCreate };
    checkout = { sessions: { create: mockSessionsCreate } };
  },
}));

vi.mock('../db/client', () => ({
  db: { select: vi.fn() },
}));
vi.mock('../db/schema', () => ({ subscriptions: {} }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));
vi.mock('../middleware/auth', () => ({
  authPreHandler: vi.fn(async (req: { user: unknown }) => {
    req.user = { clerkId: 'clerk_test', email: 'test@test.com', userId: 'uuid-test' };
  }),
}));

import Fastify from 'fastify';
import { db } from '../db/client';
import { billingRoutes } from './billing';

function buildApp() {
  const app = Fastify();
  void app.register(billingRoutes);
  return app;
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
  vi.mocked(db.select).mockReturnValue(selectChain([])); // no existing sub by default
  mockCustomersSearch.mockResolvedValue({ data: [] });
  mockCustomersCreate.mockResolvedValue({ id: 'cus_new' });
  mockSessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/pay/test_session' });
});

describe('POST /v1/billing/checkout', () => {
  it('returns 401 without auth (auth prehandler can reject)', async () => {
    // Temporarily make auth reject
    const { authPreHandler } = await import('../middleware/auth');
    vi.mocked(authPreHandler).mockImplementationOnce(async (_req, reply) => {
      await reply.status(401).send({ error: 'unauthorized' });
    });
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/v1/billing/checkout', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('returns 500 when STRIPE_PRICE_ID is not set', async () => {
    const saved = process.env.STRIPE_PRICE_ID;
    delete process.env.STRIPE_PRICE_ID;
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/v1/billing/checkout', payload: {} });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'billing_not_configured' });
    process.env.STRIPE_PRICE_ID = saved;
  });

  it('creates a new Stripe customer and returns checkout URL', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/v1/billing/checkout', payload: {} });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.url).toBe('https://checkout.stripe.com/pay/test_session');
    expect(mockCustomersCreate).toHaveBeenCalledWith({
      email: 'test@test.com',
      metadata: { clerk_id: 'clerk_test' },
    });
    expect(mockSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_new', mode: 'subscription' }),
    );
  });

  it('reuses an existing Stripe customer found by clerk_id metadata', async () => {
    mockCustomersSearch.mockResolvedValue({ data: [{ id: 'cus_existing' }] });
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/v1/billing/checkout', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(mockCustomersCreate).not.toHaveBeenCalled();
    expect(mockSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_existing' }),
    );
  });

  it('reuses the Stripe customer from an existing subscription row', async () => {
    vi.mocked(db.select).mockReturnValue(selectChain([{ stripeCustomerId: 'cus_from_db' }]));
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/v1/billing/checkout', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(mockCustomersSearch).not.toHaveBeenCalled();
    expect(mockCustomersCreate).not.toHaveBeenCalled();
    expect(mockSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_from_db' }),
    );
  });
});
