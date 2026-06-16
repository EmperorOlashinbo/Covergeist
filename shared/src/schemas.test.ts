import { describe, it, expect } from 'vitest';
import {
  CodeSnippetSchema,
  GenerateRequestSchema,
  GenerateResponseSchema,
  QuotaResponseSchema,
  SubscriptionResponseSchema,
} from './schemas';

describe('CodeSnippetSchema', () => {
  const valid = {
    language: 'typescript',
    runner: 'jest' as const,
    functionName: 'myFn',
    snippetCode: 'function myFn() {}',
    contextCode: '',
    relativeFilePath: 'src/myFn.ts',
  };

  it('accepts a valid snippet', () => {
    expect(CodeSnippetSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts vitest runner', () => {
    expect(CodeSnippetSchema.safeParse({ ...valid, runner: 'vitest' }).success).toBe(true);
  });

  it('rejects unknown runner', () => {
    expect(CodeSnippetSchema.safeParse({ ...valid, runner: 'mocha' }).success).toBe(false);
  });

  it('rejects snippetCode exceeding 8000 chars', () => {
    const result = CodeSnippetSchema.safeParse({ ...valid, snippetCode: 'x'.repeat(8001) });
    expect(result.success).toBe(false);
  });

  it('accepts snippetCode at exactly 8000 chars', () => {
    const result = CodeSnippetSchema.safeParse({ ...valid, snippetCode: 'x'.repeat(8000) });
    expect(result.success).toBe(true);
  });

  it('rejects contextCode exceeding 2000 chars', () => {
    const result = CodeSnippetSchema.safeParse({ ...valid, contextCode: 'x'.repeat(2001) });
    expect(result.success).toBe(false);
  });

  it('accepts contextCode at exactly 2000 chars', () => {
    const result = CodeSnippetSchema.safeParse({ ...valid, contextCode: 'x'.repeat(2000) });
    expect(result.success).toBe(true);
  });

  it('rejects missing required fields', () => {
    const { functionName: _, ...without } = valid;
    expect(CodeSnippetSchema.safeParse(without).success).toBe(false);
  });
});

describe('GenerateRequestSchema', () => {
  it('accepts a valid request', () => {
    const result = GenerateRequestSchema.safeParse({
      snippet: {
        language: 'typescript',
        runner: 'jest',
        functionName: 'fn',
        snippetCode: 'code',
        contextCode: '',
        relativeFilePath: 'src/fn.ts',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing snippet', () => {
    expect(GenerateRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('GenerateResponseSchema', () => {
  it('accepts a valid response', () => {
    const result = GenerateResponseSchema.safeParse({
      test: 'describe(...)',
      suggestedTestFilePath: 'src/fn.test.ts',
    });
    expect(result.success).toBe(true);
  });
});

describe('QuotaResponseSchema', () => {
  it('accepts a valid quota', () => {
    const result = QuotaResponseSchema.safeParse({
      used: 5,
      limit: 50,
      resetAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-integer used', () => {
    const result = QuotaResponseSchema.safeParse({ used: 5.5, limit: 50, resetAt: new Date().toISOString() });
    expect(result.success).toBe(false);
  });
});

describe('SubscriptionResponseSchema', () => {
  const validStatuses = ['active', 'canceled', 'past_due', 'trialing', 'none'] as const;

  for (const status of validStatuses) {
    it(`accepts status "${status}"`, () => {
      const result = SubscriptionResponseSchema.safeParse({ status, currentPeriodEnd: null });
      expect(result.success).toBe(true);
    });
  }

  it('accepts non-null currentPeriodEnd', () => {
    const result = SubscriptionResponseSchema.safeParse({
      status: 'active',
      currentPeriodEnd: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown status', () => {
    const result = SubscriptionResponseSchema.safeParse({ status: 'unknown', currentPeriodEnd: null });
    expect(result.success).toBe(false);
  });
});
