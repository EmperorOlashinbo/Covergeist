# Test Automation Summary

## Generated Tests

### Shared Package (`shared/src/`)

- [x] `shared/src/schemas.test.ts` — Zod schema validation (20 tests)
  - `CodeSnippetSchema`: valid input, runner enum, 8000-char snippetCode boundary, 2000-char contextCode boundary, missing fields
  - `GenerateRequestSchema`: valid request, missing snippet
  - `GenerateResponseSchema`: valid response shape
  - `QuotaResponseSchema`: valid quota, non-integer rejection
  - `SubscriptionResponseSchema`: all 5 status values, non-null currentPeriodEnd, unknown status rejection

### Backend — LLM Layer (`backend/src/llm/`)

- [x] `backend/src/llm/TypeScriptStrategy.test.ts` — Pure function tests (12 tests)
  - `buildPrompt`: file path in user message, Jest vs Vitest system prompt, contextCode inclusion/exclusion, "no markdown fences" instruction
  - `sanitiseResponse`: plain code passthrough, typescript/plain fence stripping, missing closing fence, whitespace trimming, internal newline preservation

- [x] `backend/src/llm/AnthropicClient.test.ts` — Fetch-mocked unit tests (5 tests)
  - Happy path text extraction, correct headers + model sent, 12-second abort timeout → `LLMTimeoutError`, non-OK status → plain Error, empty content array → empty string

### Backend — Middleware (`backend/src/middleware/`)

- [x] `backend/src/middleware/auth.test.ts` — Fastify inject tests (6 tests)
  - Missing Authorization header, non-Bearer scheme, JWT verification failure, missing `sub` claim, valid JWT attaches user (email_address), fallback to `email` claim

- [x] `backend/src/middleware/quota.test.ts` — Fastify inject tests (5 tests)
  - No subscription → 403, canceled subscription → 403, null `currentPeriodStart` → allow through, quota exhausted (used ≥ limit) → 402, quota remaining → 200 + `billingPeriodStart` attached

### Backend — Routes (`backend/src/routes/`)

- [x] `backend/src/routes/subscription.test.ts` — Fastify inject tests (3 tests)
  - No row → `{status: 'none', currentPeriodEnd: null}`, active sub with date, null `currentPeriodEnd`

- [x] `backend/src/routes/quota.test.ts` — Fastify inject tests (3 tests)
  - No subscription → 403, used/limit/resetAt returned correctly, `currentPeriodStart` null → used=0

- [x] `backend/src/routes/generate.test.ts` — Fastify inject tests (6 tests)
  - Zod validation error → 400, success path + `suggestedTestFilePath` derivation (nested path, no extension), `LLMTimeoutError` → 504, `generation_log` insert verified

- [x] `backend/src/routes/webhooks/stripe.test.ts` — Fastify inject tests (8 tests)
  - Missing signature → 400, bad signature → 400, `customer.subscription.updated` → update called, `customer.subscription.deleted` → canceled, `invoice.payment_failed` → past_due, unknown event → 200 no side effects, null subscription on invoice → skip update, new subscription fallback path (customer lookup + insert)

## Coverage

| Area | Files tested | Tests |
|------|-------------|-------|
| Shared schemas | 1/1 | 20 |
| LLM strategy + client | 2/2 | 17 |
| Auth + quota middleware | 2/2 | 11 |
| Routes (subscription, quota, generate, webhook) | 4/4 | 20 |
| **Total** | **9/9** | **69** |

Excluded: `extension/` — requires `@vscode/test-electron` (full VS Code runtime). Backend `index.ts` and `db/client.ts` excluded from coverage (server bootstrap + DB connection string).

## Test Framework

- **Vitest** 4.1.9 + `@vitest/coverage-v8` added to `backend/` and `shared/`
- Run: `pnpm --filter @covergeist/backend test` / `pnpm --filter @covergeist/shared test`
- Coverage: `pnpm --filter @covergeist/backend test:coverage`

## Key Patterns Used

- `vi.hoisted()` for mocks that must exist before module-level constructors run (AnthropicClient instantiation in `generate.ts`, Stripe constructor, CLERK_JWKS_URL env var)
- Thenable chain mock for Drizzle ORM to support both `.limit()`-terminated and `.where()`-terminated queries
- `vi.fn()` class mocks for Stripe constructor using `class MockStripe { ... }` pattern (arrow functions can't be used as constructors)
- Fastify `app.inject()` for route testing without starting a real HTTP server

## Next Steps

- Add `pnpm -r test` to CI/CD pipeline
- Consider adding VS Code extension tests via `@vscode/test-electron` for the generation flow
- Review coverage report with `pnpm --filter @covergeist/backend test:coverage`
