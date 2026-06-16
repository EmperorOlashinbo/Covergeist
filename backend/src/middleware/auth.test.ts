import { describe, it, expect, vi, beforeEach } from 'vitest';

// Must run before module imports so new URL(...) in auth.ts doesn't throw
vi.hoisted(() => {
  process.env.CLERK_JWKS_URL = 'https://test.example.com/.well-known/jwks.json';
});

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => 'mock-jwks'),
  jwtVerify: vi.fn(),
}));

vi.mock('../db/client', () => ({
  db: { insert: vi.fn() },
}));
vi.mock('../db/schema', () => ({ users: {} }));

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { jwtVerify } from 'jose';
import { db } from '../db/client';
import { authPreHandler } from './auth';

function buildApp(): FastifyInstance {
  const app = Fastify();
  app.get('/protected', { preHandler: authPreHandler }, async (req) => ({
    userId: req.user.userId,
    email: req.user.email,
  }));
  return app;
}

function mockInsertImpl() {
  return {
    values: () => ({
      onConflictDoUpdate: () => ({
        returning: () => Promise.resolve([{ id: 'user-uuid-123' }]),
      }),
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.insert).mockReturnValue(mockInsertImpl() as ReturnType<typeof db.insert>);
});

describe('authPreHandler', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'unauthorized' });
  });

  it('returns 401 when Authorization header is not Bearer', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Basic abc123' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when JWT verification fails', async () => {
    vi.mocked(jwtVerify).mockRejectedValue(new Error('invalid token'));
    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer bad-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when JWT has no sub claim', async () => {
    vi.mocked(jwtVerify).mockResolvedValue({ payload: {} } as Awaited<ReturnType<typeof jwtVerify>>);
    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer no-sub-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('attaches user to request and returns 200 on valid JWT', async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: { sub: 'clerk-id-abc', email_address: 'user@example.com' },
    } as Awaited<ReturnType<typeof jwtVerify>>);

    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.userId).toBe('user-uuid-123');
    expect(body.email).toBe('user@example.com');
  });

  it('falls back to email claim when email_address is absent', async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: { sub: 'clerk-id-abc', email: 'fallback@example.com' },
    } as Awaited<ReturnType<typeof jwtVerify>>);

    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).email).toBe('fallback@example.com');
  });
});
