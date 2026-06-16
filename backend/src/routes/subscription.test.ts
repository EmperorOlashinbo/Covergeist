import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../db/client', () => ({ db: { select: vi.fn() } }));
vi.mock('../db/schema', () => ({ subscriptions: {} }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(), desc: vi.fn(), and: vi.fn(), count: vi.fn(() => 'count()') }));
vi.mock('../middleware/auth', () => ({
  authPreHandler: async (req: { user: { userId: string; clerkId: string; email: string } }) => {
    req.user = { userId: 'user-123', clerkId: 'clerk-123', email: 'u@test.com' };
  },
}));

import { db } from '../db/client';
import { subscriptionRoutes } from './subscription';

type SelectChain = { from: () => SelectChain; where: () => SelectChain; limit: () => Promise<unknown[]> };
function chain(rows: unknown[]): SelectChain {
  const c: SelectChain = { from: () => c, where: () => c, limit: () => Promise.resolve(rows) };
  return c;
}

beforeEach(() => vi.clearAllMocks());

describe('GET /v1/subscription', () => {
  it('returns status none when no subscription row exists', async () => {
    vi.mocked(db.select).mockReturnValue(chain([]) as ReturnType<typeof db.select>);
    const app = Fastify();
    await app.register(subscriptionRoutes);
    const res = await app.inject({ method: 'GET', url: '/v1/subscription' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'none', currentPeriodEnd: null });
  });

  it('returns subscription status and currentPeriodEnd when row exists', async () => {
    const end = new Date('2026-07-01T00:00:00.000Z');
    vi.mocked(db.select).mockReturnValue(
      chain([{ status: 'active', currentPeriodEnd: end }]) as ReturnType<typeof db.select>,
    );
    const app = Fastify();
    await app.register(subscriptionRoutes);
    const res = await app.inject({ method: 'GET', url: '/v1/subscription' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('active');
    expect(body.currentPeriodEnd).toBe(end.toISOString());
  });

  it('returns null currentPeriodEnd when column is null', async () => {
    vi.mocked(db.select).mockReturnValue(
      chain([{ status: 'trialing', currentPeriodEnd: null }]) as ReturnType<typeof db.select>,
    );
    const app = Fastify();
    await app.register(subscriptionRoutes);
    const res = await app.inject({ method: 'GET', url: '/v1/subscription' });
    expect(JSON.parse(res.body).currentPeriodEnd).toBeNull();
  });
});
