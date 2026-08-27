import { z } from 'zod';

export const CodeSnippetSchema = z.object({
  language: z.string(),
  runner: z.enum(['jest', 'vitest']),
  functionName: z.string(),
  snippetCode: z.string().max(8000),
  contextCode: z.string().max(2000),
  relativeFilePath: z.string(),
});

export const GenerateRequestSchema = z.object({
  snippet: CodeSnippetSchema,
});

export const GenerateResponseSchema = z.object({
  test: z.string(),
  suggestedTestFilePath: z.string(),
});

// File-level generation: all uncovered functions in one request
export const UncoveredFunctionSchema = z.object({
  name: z.string(),
  code: z.string().max(3000),
});

export const FileSnippetSchema = z.object({
  language: z.string(),
  runner: z.enum(['jest', 'vitest']),
  relativeFilePath: z.string(),
  uncoveredFunctions: z.array(UncoveredFunctionSchema).min(1).max(20),
  contextCode: z.string().max(3000),
});

export const FileGenerateRequestSchema = z.object({
  fileSnippet: FileSnippetSchema,
});

export type UncoveredFunction = z.infer<typeof UncoveredFunctionSchema>;
export type FileSnippet = z.infer<typeof FileSnippetSchema>;

export const QuotaResponseSchema = z.object({
  used: z.number().int(),
  limit: z.number().int(),
  resetAt: z.string().datetime(),
});

export const SubscriptionResponseSchema = z.object({
  status: z.enum(['active', 'canceled', 'past_due', 'trialing', 'none']),
  currentPeriodEnd: z.string().datetime().nullable(),
});

export type CodeSnippet = z.infer<typeof CodeSnippetSchema>;
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;
export type GenerateResponse = z.infer<typeof GenerateResponseSchema>;
export type FileGenerateRequest = z.infer<typeof FileGenerateRequestSchema>;
export type QuotaResponse = z.infer<typeof QuotaResponseSchema>;
export type SubscriptionResponse = z.infer<typeof SubscriptionResponseSchema>;
