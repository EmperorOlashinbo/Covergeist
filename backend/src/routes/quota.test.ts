import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../db/client', () => ({ db: { select: vi.fn() } }));
vi.mock('../db/schema', () => ({ subscriptions: {}, generationLog: {} }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(), and: vi.fn(), count: vi.fn(() => 'count()'), desc: vi.fn() }));
vi.mock('../middleware/auth', () => ({
  authPreHandler: async (req: { user: { userId: string; clerkId: string; email: string } }) => {
    req.user = { userId: 'user-123', clerkId: 'clerk-123', email: 'u@test.com' };
  },
}));

import { db } from '../db/client';
import { quotaRoutes } from './quota';

// Thenable chain: supports queries ending with .limit() or .where()
function chain(rows: unknown[]) {
  const p = Promise.resolve(rows);
  const c: Record<string, unknown> = {
    from: () => c,
    where: () => c,
    orderBy: () => c,
    limit: () => p,
    then: p.then.bind(p),
    catch: p.catch.bind(p),
    finally: p.finally.bind(p),
  };
  return c as ReturnType<typeof db.select>;
}

beforeEach(() => vi.clearAllMocks());

describe('GET /v1/quota', () => {
  it('returns 403 when no active subscription', async () => {
    vi.mocked(db.select).mockReturnValue(chain([]));
    const app = Fastify();
    await app.register(quotaRoutes);
    const res = await app.inject({ method: 'GET', url: '/v1/quota' });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'no_subscription' });
  });

  it('returns used/limit/resetAt for an active subscription', async () => {
    const end = new Date('2026-07-01T00:00:00.000Z');
    const subRow = { status: 'active', currentPeriodStart: '2026-06-01', currentPeriodEnd: end, generationsLimit: 50 };
    let callCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      callCount++;
      return chain(callCount === 1 ? [subRow] : [{ count: 7 }]);
    });

    const app = Fastify();
    await app.register(quotaRoutes);
    const res = await app.inject({ method: 'GET', url: '/v1/quota' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.used).toBe(7);
    expect(body.limit).toBe(50);
    expect(body.resetAt).toBe(end.toISOString());
  });

  it('returns used=0 when currentPeriodStart is null', async () => {
    vi.mocked(db.select).mockReturnValue(
      chain([{ status: 'active', currentPeriodStart: null, currentPeriodEnd: new Date(), generationsLimit: 50 }]),
    );
    const app = Fastify();
    await app.register(quotaRoutes);
    const res = await app.inject({ method: 'GET', url: '/v1/quota' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).used).toBe(0);
  });
});
