import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

vi.mock('../db/client', () => ({ db: { select: vi.fn() } }));
vi.mock('../db/schema', () => ({ subscriptions: {}, generationLog: {} }));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  count: vi.fn(() => 'count()'),
  desc: vi.fn(),
}));

import { db } from '../db/client';
import { quotaPreHandler } from './quota';

async function userPreHandler(request: { user: { userId: string; clerkId: string; email: string } }) {
  request.user = { userId: 'user-123', clerkId: 'clerk-123', email: 'u@test.com' };
}

function buildApp(): FastifyInstance {
  const app = Fastify();
  app.get('/test', { preHandler: [userPreHandler as never, quotaPreHandler] }, async (req) => ({
    billingPeriodStart: req.billingPeriodStart,
  }));
  return app;
}

// Thenable chain: works for queries ending with .limit() or .where() / .orderBy()
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

describe('quotaPreHandler', () => {
  it('returns 403 when no subscription exists', async () => {
    vi.mocked(db.select).mockReturnValue(chain([]));
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'no_subscription' });
  });

  it('returns 403 when subscription status is canceled', async () => {
    vi.mocked(db.select).mockReturnValue(
      chain([{ status: 'canceled', currentPeriodStart: '2026-06-01', currentPeriodEnd: new Date(), generationsLimit: 50 }]),
    );
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(403);
  });

  it('allows through without counting when currentPeriodStart is null', async () => {
    vi.mocked(db.select).mockReturnValue(
      chain([{ status: 'active', currentPeriodStart: null, currentPeriodEnd: new Date(), generationsLimit: 50 }]),
    );
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(200);
  });

  it('returns 402 when quota is exhausted', async () => {
    const subRow = { status: 'active', currentPeriodStart: '2026-06-01', currentPeriodEnd: new Date('2026-07-01'), generationsLimit: 50 };
    let callCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      callCount++;
      return chain(callCount === 1 ? [subRow] : [{ count: 50 }]);
    });

    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(402);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('quota_exceeded');
    expect(body.remaining).toBe(0);
  });

  it('attaches billingPeriodStart and allows through when quota remains', async () => {
    const subRow = { status: 'trialing', currentPeriodStart: '2026-06-01', currentPeriodEnd: new Date('2026-07-01'), generationsLimit: 50 };
    let callCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      callCount++;
      return chain(callCount === 1 ? [subRow] : [{ count: 10 }]);
    });

    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).billingPeriodStart).toBe('2026-06-01');
  });
});
