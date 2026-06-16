import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted ensures mockGenerate exists when generate.ts module-level
// `const anthropic = new AnthropicClient(...)` runs during import.
const mockGenerate = vi.hoisted(() => vi.fn());
const mockInsertValues = vi.hoisted(() => vi.fn());

vi.mock('../llm/AnthropicClient', () => ({
  AnthropicClient: class MockAnthropicClient {
    generate = mockGenerate;
  },
  LLMTimeoutError: class LLMTimeoutError extends Error {
    constructor() {
      super('LLM did not respond within 12 seconds');
      this.name = 'LLMTimeoutError';
    }
  },
}));

vi.mock('../llm/TypeScriptStrategy', () => ({
  TypeScriptStrategy: {
    buildPrompt: vi.fn(() => ({ system: 'sys', user: 'usr' })),
    sanitiseResponse: vi.fn((raw: string) => raw.trim()),
  },
}));

vi.mock('../db/client', () => ({
  db: { insert: vi.fn() },
}));
vi.mock('../db/schema', () => ({ generationLog: {} }));

vi.mock('../middleware/auth', () => ({
  authPreHandler: async (req: { user: { userId: string; clerkId: string; email: string } }) => {
    req.user = { userId: 'user-123', clerkId: 'clerk-123', email: 'u@test.com' };
  },
}));
vi.mock('../middleware/quota', () => ({
  quotaPreHandler: async (req: { billingPeriodStart: string }) => {
    req.billingPeriodStart = '2026-06-01';
  },
}));

import Fastify from 'fastify';
import { db } from '../db/client';
import { generateRoutes } from './generate';
import { LLMTimeoutError } from '../llm/AnthropicClient';

const validBody = {
  snippet: {
    language: 'typescript',
    runner: 'jest',
    functionName: 'add',
    snippetCode: 'function add(a: number, b: number) { return a + b; }',
    contextCode: '',
    relativeFilePath: 'src/math.ts',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.insert).mockReturnValue({
    values: mockInsertValues,
  } as ReturnType<typeof db.insert>);
  mockInsertValues.mockResolvedValue(undefined);
});

describe('POST /v1/generate', () => {
  it('returns 400 for invalid request body', async () => {
    const app = Fastify();
    await app.register(generateRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/generate',
      payload: { snippet: { language: 'typescript' } },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('validation_error');
  });

  it('returns 200 with test and suggestedTestFilePath on success', async () => {
    mockGenerate.mockResolvedValue('describe("add", () => { it("works", () => {}); });');
    const app = Fastify();
    await app.register(generateRoutes);
    const res = await app.inject({ method: 'POST', url: '/v1/generate', payload: validBody });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.test).toBe('describe("add", () => { it("works", () => {}); });');
    expect(body.suggestedTestFilePath).toBe('src/math.test.ts');
  });

  it('derives suggestedTestFilePath correctly for nested paths', async () => {
    mockGenerate.mockResolvedValue('test code');
    const app = Fastify();
    await app.register(generateRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/generate',
      payload: { snippet: { ...validBody.snippet, relativeFilePath: 'src/utils/helpers.ts' } },
    });
    expect(JSON.parse(res.body).suggestedTestFilePath).toBe('src/utils/helpers.test.ts');
  });

  it('derives suggestedTestFilePath for files without extension', async () => {
    mockGenerate.mockResolvedValue('test code');
    const app = Fastify();
    await app.register(generateRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/generate',
      payload: { snippet: { ...validBody.snippet, relativeFilePath: 'src/helper' } },
    });
    expect(JSON.parse(res.body).suggestedTestFilePath).toBe('src/helper.test');
  });

  it('returns 504 when LLM times out', async () => {
    mockGenerate.mockRejectedValue(new LLMTimeoutError());
    const app = Fastify();
    await app.register(generateRoutes);
    const res = await app.inject({ method: 'POST', url: '/v1/generate', payload: validBody });
    expect(res.statusCode).toBe(504);
    expect(JSON.parse(res.body)).toEqual({ error: 'llm_timeout' });
  });

  it('inserts a generation_log row on success', async () => {
    mockGenerate.mockResolvedValue('test');
    const app = Fastify();
    await app.register(generateRoutes);
    await app.inject({ method: 'POST', url: '/v1/generate', payload: validBody });
    expect(mockInsertValues).toHaveBeenCalledWith({
      userId: 'user-123',
      billingPeriodStart: '2026-06-01',
    });
  });
});
