# Covergeist — Technical Architecture

> BMAD artifact: `docs/architecture.md` — produced by the Architect agent.
> Status: v1.0. Feeds the Developer agent.

---

## 1. System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      Developer's machine                     │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                   VS Code Extension                   │   │
│  │                                                       │   │
│  │  AdapterRegistry → TypeScriptAdapter                 │   │
│  │       ↓ (local spawn)                                │   │
│  │  CoverageService → DecorationProvider                │   │
│  │       ↓ (on generate click)                          │   │
│  │  GenerationService → BackendClient ─────────────────────────────┐
│  │  AuthService (Clerk PKCE, SecretStorage)             │   │      │
│  │  QuotaService (status bar display)                   │   │      │
│  └──────────────────────────────────────────────────────┘   │      │
│                                                              │      │
│  Project files, LCOV output — never leave this machine       │      │
│  except: bounded CodeSnippet in the generate request ────────────────┘
└─────────────────────────────────────────────────────────────┘
                                                               │
                                              HTTPS (snippet + JWT)
                                                               │
                                                               ▼
                                        ┌──────────────────────────────┐
                                        │      Backend (Railway)        │
                                        │      Fastify / Node.js        │
                                        │                              │
                                        │  AuthMiddleware (Clerk JWKS) │
                                        │  QuotaMiddleware (Neon)      │
                                        │  GenerateRoute               │
                                        │  StrategyRegistry            │
                                        │    └─ TypeScriptStrategy     │
                                        │  AnthropicClient ───────────────→ Claude API
                                        │                              │
                                        │  QuotaRoute                  │
                                        │  SubscriptionRoute           │
                                        │  StripeWebhookRoute ←────────────── Stripe
                                        └──────────────┬───────────────┘
                                                       │
                                                       ▼
                                              ┌────────────────┐
                                              │  Neon (Postgres)│
                                              │  users          │
                                              │  subscriptions  │
                                              │  generation_log │
                                              └────────────────┘

External (cloud):  Clerk (auth/JWT)   Stripe (billing)   Anthropic (LLM)
```

**Data that leaves the developer's machine:** only the `CodeSnippet` payload (selected function body + up to 10 lines of surrounding context + relative file path) and the Clerk JWT. The full project never touches the network.

---

## 2. Tech Stack

| Layer | Technology | Justification |
|---|---|---|
| Extension language | TypeScript | Fixed by brief |
| Backend language | TypeScript | Fixed by brief |
| Backend framework | Fastify | TypeScript-first, schema-validated routes, fast; beats Express on DX and throughput |
| Schema validation | Zod | Shared types between extension and backend via the `shared` package; single source of truth for API shapes |
| ORM | Drizzle | Lightweight, TypeScript-native, schema-as-code, no runtime magic |
| Database | Neon (PostgreSQL) | Serverless Postgres, generous free tier, no idle cost pre-revenue |
| Auth provider | Clerk | PKCE/native-app flow for VS Code extensions; manages JWT issuance and JWKS; session persistence via SecretStorage |
| Billing | Stripe | Only viable choice at MVP scale; webhook-driven subscription sync |
| LLM | Anthropic Claude (claude-haiku-3-5) | Reliable instruction-following for constrained output; fast; cost-effective at €0.001–0.003/generation |
| Deployment | Railway | Zero-config Node.js deploys, environment variable management, pay-as-you-go |
| Monorepo tooling | pnpm workspaces | Shares the `shared` package between extension and backend without publishing to npm |

---

## 3. Component Breakdown

### 3.1 Extension components

**`ExtensionCore` (`extension.ts`)**
Entry point. Implements `activate` and `deactivate`. Instantiates all services, registers VS Code commands (`covergeist.runScan`, `covergeist.generateTest`, `covergeist.signIn`, `covergeist.openBilling`), and registers the URI handler for the Clerk auth callback.

**`AdapterRegistry`**
Holds the list of registered `LanguageAdapter` instances. On workspace open, iterates adapters and calls `canHandle(projectRoot)` to select the active adapter. Exposes the selected adapter to other services. In v1, only `TypeScriptAdapter` is registered.

**`TypeScriptAdapter`**
The sole v1 implementation of `LanguageAdapter`. Handles detection, coverage execution, LCOV parsing, snippet extraction, and test file path resolution for TypeScript and JavaScript projects. Detailed in §4.

**`CoverageService`**
Orchestrates coverage runs. On `runScan` command: asks the registry for the active adapter, calls `runCoverage`, then `parseCoverage`, stores the result in an in-memory cache, and notifies `DecorationProvider`. Manages the spawn process lifecycle (timeout at 60 seconds — a safety ceiling above the PRD's 30-second target, since the extension can't control suite speed). Exposes `getCoverageForFile(uri)` to other components.

**`DecorationProvider`**
Consumes `CoverageMap` from `CoverageService`. Applies VS Code `TextEditorDecorationType` decorations: a gutter icon and a faint line highlight on uncovered lines; a distinct gutter icon on uncovered function signatures. Registers a `vscode.window.onDidChangeActiveTextEditor` listener to re-apply decorations when the user switches files. Also provides the code action (`vscode.CodeActionProvider`) that surfaces "Generate test for this function" on haunted lines.

**`GenerationService`**
Handles the full generate → preview → accept/reject flow. On "Generate test": checks `AuthService` for a valid session (prompts sign-in if absent), checks `QuotaService` for remaining quota (shows upgrade prompt if zero), calls `adapter.extractSnippet`, sends `POST /v1/generate` via `BackendClient`, receives the test string, opens a VS Code diff editor (`vscode.diff`) between the current test file content and the content with the generated test appended. On accept: writes to disk, triggers a `CoverageService` re-scan. On reject: closes the diff editor, no disk writes.

**`AuthService`**
Manages the Clerk PKCE auth flow. On sign-in: constructs the Clerk PKCE authorization URL, calls `vscode.env.openExternal`, registers a `vscode.window.registerUriHandler` for the `vscode://publisher.covergeist/auth` callback, exchanges the authorization code for tokens, stores the refresh token in `vscode.SecretStorage`, stores the access token in memory. Provides `getAccessToken(): Promise<string>` — transparently refreshes using the stored refresh token when expired. On sign-out: clears both stores.

**`QuotaService`**
Polls `GET /v1/quota` on extension activation and after any billing-related action. After `AuthService` confirms a session exists, also starts a short polling cycle (every 10 seconds, up to 5 minutes) when the billing URL is opened — this is how PRD story 4.4 (subscription status auto-refresh without restart) is satisfied. Exposes `getQuota()` for the status bar item and `hasRemainingQuota(): boolean` for `GenerationService`. Updates the VS Code status bar item with "Covergeist: N generations left."

**`BackendClient`**
Typed HTTP client wrapping `fetch`. Accepts a base URL from extension configuration. Attaches `Authorization: Bearer <token>` on every request. Throws typed errors for 401 (session expired), 402 (quota exceeded), 403 (no subscription), and network failures. All callers handle these typed errors — none are swallowed.

---

### 3.2 Backend components

**`index.ts` (server entry)**
Instantiates the Fastify server, registers plugins (CORS, rate-limiter, Clerk JWT verifier plugin), mounts routes, connects to Neon via Drizzle, starts listening on `PORT` (Railway injects this).

**`AuthMiddleware`**
A Fastify `preHandler` hook applied to all routes except the Stripe webhook. Fetches Clerk's JWKS from `https://api.clerk.dev/v1/jwks` (cached with a 1-hour TTL). Verifies the incoming JWT signature and expiry. Extracts `clerkId` and attaches it to `request.user`. Returns 401 on failure.

**`QuotaMiddleware`**
Applied only to `POST /v1/generate`. Queries `generation_log` to count rows for `(userId, billingPeriodStart)`. Looks up the user's `generations_limit` from the `subscriptions` table. If `used >= limit`, returns 402 with `{ error: 'quota_exceeded', remaining: 0, resetAt }`. Otherwise, proceeds. After the route handler succeeds, inserts a row into `generation_log`.

**`GenerateRoute` (`POST /v1/generate`)**
Validates the request body against the Zod `GenerateRequestSchema`. Resolves the `GenerationStrategy` from `StrategyRegistry` by `language`. Calls `strategy.buildPrompt(snippet, runner)`, sends it to `AnthropicClient`, calls `strategy.sanitiseResponse(raw)`, returns `{ test, suggestedTestFilePath }`. The raw LLM response is never persisted.

**`QuotaRoute` (`GET /v1/quota`)**
Returns `{ used, limit, resetAt }` for the authenticated user's current billing period.

**`SubscriptionRoute` (`GET /v1/subscription`)**
Returns `{ status, currentPeriodEnd }` from the `subscriptions` table.

**`StripeWebhookRoute` (`POST /v1/webhooks/stripe`)**
Verifies the `Stripe-Signature` header using the Stripe webhook secret. Handles `customer.subscription.updated` and `customer.subscription.deleted` events: upserts the `subscriptions` row. Handles `invoice.payment_failed`: sets `status = 'past_due'`. Returns 200 immediately on unrecognised event types (Stripe expects fast responses).

**`StrategyRegistry`**
Same pattern as the client-side `AdapterRegistry`. In v1, holds one entry: `TypeScriptStrategy`.

**`TypeScriptStrategy`**
Implements `GenerationStrategy` for `language = 'typescript'`. `buildPrompt` returns a system prompt that instructs Claude to output only valid TypeScript test code, no markdown, no explanations, targeting the specified runner. `sanitiseResponse` strips any accidental ` ``` ` fences and trims whitespace.

**`AnthropicClient`**
Wraps the Anthropic SDK. Sends messages to `claude-haiku-3-5` with a hard `max_tokens` limit (sufficient for a single test function — prevents runaway cost). Enforces a 12-second timeout (leaves margin against the PRD's 15-second user-facing requirement). Throws a typed `LLMTimeoutError` on expiry.

---

## 4. Key Abstractions

### 4.1 `LanguageAdapter` (extension)

```typescript
// extension/src/adapters/LanguageAdapter.ts

export type TestRunner = 'jest' | 'vitest';

export interface FileCoverage {
  lines: Map<number, boolean>;       // line number → is covered
  functions: Map<string, boolean>;   // function name → is covered
}

export interface CoverageMap {
  files: Map<string, FileCoverage>;  // absolute file path → coverage
}

export interface CodeSnippet {
  language: string;                  // 'typescript'
  runner: TestRunner;
  functionName: string;
  snippetCode: string;               // the target function body only
  contextCode: string;               // up to 10 lines of surrounding context
  relativeFilePath: string;          // relative to project root
}

export interface LanguageAdapter {
  readonly id: string;               // 'typescript'
  readonly displayName: string;      // 'TypeScript / JavaScript'

  canHandle(projectRoot: string): Promise<boolean>;
  detectRunner(projectRoot: string): Promise<TestRunner | null>;
  runCoverage(projectRoot: string, runner: TestRunner): Promise<string>;    // → absolute lcov path
  parseCoverage(lcovPath: string): Promise<CoverageMap>;
  extractSnippet(document: vscode.TextDocument, range: vscode.Range): Promise<CodeSnippet>;
  resolveTestFilePath(sourceFilePath: string, projectRoot: string): string;
}
```

### 4.2 `GenerationStrategy` (backend)

```typescript
// backend/src/generation/GenerationStrategy.ts

export interface LLMPrompt {
  system: string;
  user: string;
}

export interface GenerationStrategy {
  readonly language: string;         // 'typescript'

  buildPrompt(snippet: CodeSnippet, runner: TestRunner): LLMPrompt;
  sanitiseResponse(raw: string): string;
}
```

### 4.3 `AdapterRegistry` (extension) and `StrategyRegistry` (backend)

```typescript
// extension/src/adapters/AdapterRegistry.ts
export class AdapterRegistry {
  register(adapter: LanguageAdapter): void;
  resolve(projectRoot: string): Promise<LanguageAdapter | null>;
}

// backend/src/generation/StrategyRegistry.ts
export class StrategyRegistry {
  register(strategy: GenerationStrategy): void;
  resolve(language: string): GenerationStrategy;  // throws if not found
}
```

### 4.4 Shared Zod schemas (`shared` package)

```typescript
// shared/src/schemas.ts

export const CodeSnippetSchema = z.object({
  language: z.string(),
  runner: z.enum(['jest', 'vitest']),
  functionName: z.string(),
  snippetCode: z.string().max(8000),    // hard cap — prevents oversized payloads
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

export const QuotaResponseSchema = z.object({
  used: z.number().int(),
  limit: z.number().int(),
  resetAt: z.string().datetime(),
});

export const SubscriptionResponseSchema = z.object({
  status: z.enum(['active', 'canceled', 'past_due', 'trialing', 'none']),
  currentPeriodEnd: z.string().datetime().nullable(),
});
```

---

## 5. Data Models

Managed by Drizzle. All tables in the `public` schema on Neon.

```typescript
// backend/src/db/schema.ts

export const users = pgTable('users', {
  id:        uuid('id').primaryKey().defaultRandom(),
  clerkId:   text('clerk_id').unique().notNull(),
  email:     text('email').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const subscriptions = pgTable('subscriptions', {
  id:                   uuid('id').primaryKey().defaultRandom(),
  userId:               uuid('user_id').notNull().references(() => users.id),
  stripeCustomerId:     text('stripe_customer_id').notNull(),
  stripeSubscriptionId: text('stripe_subscription_id').unique(),
  status:               text('status').notNull(),   // 'active' | 'canceled' | 'past_due' | 'trialing'
  currentPeriodEnd:     timestamp('current_period_end', { withTimezone: true }),
  generationsLimit:     integer('generations_limit').notNull().default(50), // [TBD]
  updatedAt:            timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const generationLog = pgTable('generation_log', {
  id:                 uuid('id').primaryKey().defaultRandom(),
  userId:             uuid('user_id').notNull().references(() => users.id),
  billingPeriodStart: date('billing_period_start').notNull(),
  createdAt:          timestamp('created_at', { withTimezone: true }).defaultNow(),
  // No code content is ever stored here. This is a counter row only.
});
```

**Quota query pattern:**
```typescript
// Count generations used in the current billing period
SELECT COUNT(*) FROM generation_log
WHERE user_id = $1 AND billing_period_start = $2;
```

`billingPeriodStart` is the date of the Stripe subscription's `current_period_start`, floored to the day. This ties quota resets to the user's actual billing cycle.

---

## 6. API Contracts

Base URL: `https://api.covergeist.com` (configured in extension via `covergeist.apiUrl` setting, defaults to production).

All routes except `/v1/webhooks/stripe` require `Authorization: Bearer <clerk-access-token>`.

---

### `POST /v1/generate`

**Request**
```json
{
  "snippet": {
    "language": "typescript",
    "runner": "jest",
    "functionName": "calculateDiscount",
    "snippetCode": "export function calculateDiscount(price: number, pct: number) { ... }",
    "contextCode": "// surrounding 10 lines of the file",
    "relativeFilePath": "src/pricing/discount.ts"
  }
}
```

**Responses**

| Status | Body | Condition |
|---|---|---|
| 200 | `{ "test": "...", "suggestedTestFilePath": "src/pricing/discount.test.ts" }` | Success |
| 400 | `{ "error": "validation_error", "details": [...] }` | Request fails Zod schema |
| 401 | `{ "error": "unauthorized" }` | Missing or invalid JWT |
| 402 | `{ "error": "quota_exceeded", "remaining": 0, "resetAt": "2025-08-01T00:00:00Z" }` | Monthly cap reached |
| 403 | `{ "error": "no_subscription" }` | Authenticated but not subscribed |
| 504 | `{ "error": "llm_timeout" }` | Anthropic did not respond within 12 seconds |

---

### `GET /v1/quota`

**Response 200**
```json
{ "used": 12, "limit": 50, "resetAt": "2025-08-01T00:00:00Z" }
```

---

### `GET /v1/subscription`

**Response 200**
```json
{ "status": "active", "currentPeriodEnd": "2025-08-01T00:00:00Z" }
```
`status` is `"none"` when no subscription row exists for the user.

---

### `POST /v1/webhooks/stripe`

**Headers:** `Stripe-Signature: <stripe-sig>`

**Handled events:**
- `customer.subscription.updated` → upsert `subscriptions` row
- `customer.subscription.deleted` → set `status = 'canceled'`
- `invoice.payment_failed` → set `status = 'past_due'`

All other event types: return 200 immediately (no-op).

---

## 7. External Integrations

### Clerk
- **Purpose:** user identity and JWT issuance.
- **Extension integration:** PKCE authorization URL constructed by the extension; auth code exchanged for tokens via Clerk's token endpoint; refresh token stored in `vscode.SecretStorage`.
- **Backend integration:** JWKS endpoint (`https://api.clerk.dev/v1/jwks`) polled at startup and cached with a 1-hour TTL. All incoming JWTs verified against this keyset. No Clerk SDK on the backend — raw JWKS verification keeps the dependency surface small.
- **User provisioning:** on first successful JWT verification, the backend upserts a `users` row using `clerkId` as the unique key.

### Stripe
- **Purpose:** subscription billing and lifecycle events.
- **Extension integration:** none. The extension only opens a browser URL to the Covergeist billing page (a separate workstream). The extension never calls Stripe directly.
- **Backend integration:** Stripe webhook events drive all subscription state changes. The backend uses the Stripe Node SDK only for webhook signature verification. Subscription status is read from the local `subscriptions` table, not from Stripe's API on each request — this keeps the generate endpoint fast and avoids Stripe rate limits.
- **Checkout:** handled entirely by the web billing workstream (out of scope for this service).

### Anthropic Claude API
- **Purpose:** test generation.
- **Integration:** the backend calls `POST https://api.anthropic.com/v1/messages` using the Anthropic Node SDK. Model: `claude-haiku-3-5`. Hard `max_tokens: 1024` (sufficient for a single test function; prevents cost blowouts on malformed requests). Temperature: 0 (deterministic output preferred for code).
- **What is sent:** the `LLMPrompt` produced by the active `GenerationStrategy` — a system prompt and a user turn containing the code snippet. Nothing else.
- **What is stored:** nothing. The response string is processed in memory and returned to the extension.

---

## 8. Security & Privacy

### Auth
- The backend verifies every request (except Stripe webhooks) using Clerk's JWKS. JWTs are short-lived (Clerk default: 60 seconds). The extension transparently refreshes using the stored refresh token.
- The refresh token is stored in VS Code's `SecretStorage`, which delegates to the OS keychain (Keychain on macOS, Credential Manager on Windows, libsecret on Linux). It is never written to disk in plaintext.

### Stripe webhooks
- Every Stripe webhook request is verified using `stripe.webhooks.constructEvent(body, sig, webhookSecret)` before any processing occurs. Requests that fail verification return 400 immediately.

### Code privacy (the hard guarantee)
- The extension never sends more than `snippetCode` (the target function) + `contextCode` (up to 10 lines of surrounding context) + `relativeFilePath` to the backend. The `relativeFilePath` is relative — it reveals nothing about the user's directory structure.
- The backend never persists the `snippetCode` or `contextCode`. The `GenerateRoute` passes them to the LLM client and discards them after the response. No logging middleware captures request bodies (configure Fastify's logger to exclude body from generation route logs).
- `generation_log` stores only `userId`, `billingPeriodStart`, and `createdAt` — a counter row with no code content.

### Secrets management
All secrets (Clerk secret key, Stripe webhook secret, Anthropic API key, Neon connection string) are injected as Railway environment variables. They are never committed to source control. The extension's only secret is the stored refresh token in `SecretStorage`.

### Rate limiting
The Fastify rate-limiter plugin applies a per-IP limit on all routes and a per-user limit on `POST /v1/generate` (stricter). This is a defence-in-depth measure — the quota middleware is the primary cost control.

---

## 9. Non-Functional Design

### Performance — coverage detection
`CoverageService` spawns the test runner with a 60-second hard timeout (above the PRD's 30-second user expectation — the extension surfaces a warning if the scan takes more than 30 seconds, so Marcus can investigate his slow suite). After the spawn completes, LCOV parsing and decoration application are synchronous operations on a cached file — target < 500ms, well inside the PRD's 2-second decoration requirement.

### Performance — generation
`AnthropicClient` enforces a 12-second timeout, leaving a 3-second margin for network overhead against the PRD's 15-second user-facing requirement. The extension shows an animated status bar progress indicator immediately when a generation request is in flight (no silent wait per NFR).

### Cost control
The monthly generation cap is enforced by `QuotaMiddleware` *before* the LLM is called. A quota-exceeded request never reaches Anthropic — it costs nothing. The `max_tokens: 1024` ceiling on every LLM call prevents runaway costs from malformed inputs. Exact cap number and subscription price are [TBD] and require cost modelling against real token usage before launch.

### Reliability
- The extension wraps all `BackendClient` calls in try/catch. Errors surface as VS Code `window.showErrorMessage` (non-blocking notification). The extension never throws unhandled rejections into the VS Code host.
- Detection works fully offline — `CoverageService` and the `TypeScriptAdapter` have no network dependencies.
- The backend is stateless between requests (session state is in Neon, not in process memory), so Railway restarts are safe and instant.

### Scalability
The backend is horizontally scalable (stateless, Neon connection-pooled). At MVP scale (hundreds of users) a single Railway instance is sufficient. Neon's serverless model scales read/write capacity automatically.

---

## 10. Deployment Topology

```
VS Code Marketplace
  └─ covergeist-extension.vsix      ← published by developer via `vsce publish`

Railway (production environment)
  └─ covergeist-backend (Node.js service)
       ├─ PORT injected by Railway
       ├─ DATABASE_URL → Neon connection string
       ├─ CLERK_SECRET_KEY
       ├─ CLERK_JWKS_URL
       ├─ STRIPE_SECRET_KEY
       ├─ STRIPE_WEBHOOK_SECRET
       └─ ANTHROPIC_API_KEY

Neon
  └─ covergeist (PostgreSQL database)
       ├─ users
       ├─ subscriptions
       └─ generation_log

External SaaS (no self-hosting required)
  ├─ Clerk       ← auth + JWKS
  ├─ Stripe      ← billing + webhooks
  └─ Anthropic   ← LLM API
```

**Monorepo structure:**
```
covergeist/
├── extension/          # VS Code extension — published to Marketplace
│   ├── src/
│   │   ├── extension.ts
│   │   ├── adapters/
│   │   │   ├── LanguageAdapter.ts
│   │   │   ├── AdapterRegistry.ts
│   │   │   └── typescript/TypeScriptAdapter.ts
│   │   ├── coverage/
│   │   │   ├── CoverageService.ts
│   │   │   └── DecorationProvider.ts
│   │   ├── generation/GenerationService.ts
│   │   ├── auth/AuthService.ts
│   │   ├── quota/QuotaService.ts
│   │   └── api/BackendClient.ts
│   └── package.json
├── backend/            # Fastify service — deployed to Railway
│   ├── src/
│   │   ├── index.ts
│   │   ├── routes/
│   │   │   ├── generate.ts
│   │   │   ├── quota.ts
│   │   │   ├── subscription.ts
│   │   │   └── webhooks/stripe.ts
│   │   ├── middleware/
│   │   │   ├── auth.ts
│   │   │   └── quota.ts
│   │   ├── generation/
│   │   │   ├── GenerationStrategy.ts
│   │   │   ├── StrategyRegistry.ts
│   │   │   └── typescript/TypeScriptStrategy.ts
│   │   ├── llm/AnthropicClient.ts
│   │   └── db/
│   │       ├── schema.ts
│   │       └── client.ts
│   └── package.json
├── shared/             # Zod schemas + shared types — internal pnpm package
│   ├── src/
│   │   └── schemas.ts
│   └── package.json
└── pnpm-workspace.yaml
```

**CI/CD:** Railway auto-deploys `backend/` on push to `main`. Extension is published manually via `vsce publish` when ready for a Marketplace release.

---

## 11. Key Decisions & Trade-offs

**ADR-1: Spawn test runner on demand (vs. reading pre-existing coverage files)**
Chosen because it delivers the "one click" promise without requiring the user to have already run coverage. Trade-off: the extension's scan time is bounded by the user's test suite speed, not the extension's code. Mitigated by the 60-second hard timeout and a 30-second in-progress warning.

**ADR-2: Fastify over Express**
TypeScript-first, schema-validated routes, better performance. Express's TypeScript story is middleware-bolted-on. No meaningful ecosystem tradeoff at this project's scale.

**ADR-3: Clerk for auth**
Best-in-class PKCE support for native/desktop app flows — which is exactly what a VS Code extension is. Avoids building JWT issuance, refresh rotation, and email verification from scratch. Trade-off: a recurring SaaS cost and an external dependency. Acceptable for MVP; can be self-hosted later if cost becomes a concern.

**ADR-4: Anthropic Claude (claude-haiku-3-5) over OpenAI**
More consistent instruction-following for constrained output formats — critical when generated code goes directly into the user's codebase. Cost is comparable. The model can be swapped to claude-sonnet-4-x or an OpenAI model without changing any interface — `AnthropicClient` is the only callsite.

**ADR-5: Split adapter interface — client handles coverage, backend handles generation strategy**
These two responsibilities live in different processes and change for different reasons. The client adapter is about file system + editor APIs; the generation strategy is about LLM prompting. Keeping them separate means adding a second language requires two small, self-contained files — one per side — with no changes to shared interfaces.

**ADR-6: No Language Server Protocol (LSP)**
LSP is for real-time incremental language features (autocomplete, hover). Coverage scanning is a batch operation triggered on demand. A regular extension host process is simpler, sufficient, and has no warm-up overhead.

**ADR-7: LCOV as canonical coverage format**
LCOV is the most portable format across Jest (istanbul, c8) and Vitest (v8, istanbul). Parsing it is a well-understood, dependency-light problem. The adapter falls back to Istanbul JSON only if LCOV is not available in the project's configured output directory.

**ADR-8: Neon (PostgreSQL) over Supabase**
We're using Clerk for auth, which makes Supabase Auth redundant. Neon gives us pure PostgreSQL with a serverless billing model and no extra services we won't use. Supabase would be the right call if we needed its realtime or storage features — we don't.

**ADR-9: Quota enforced server-side, never client-side**
The extension displays the quota for UX, but `QuotaMiddleware` enforces it. A modified extension cannot bypass the cap. LLM cost is always gated by the server.

---

## 12. Open Questions & Risks for the Development Phase

| # | Item | Owner | Blocking? |
|---|---|---|---|
| R1 | **Monthly generation cap (exact number)** — requires cost modelling against real Claude haiku token usage for a typical TypeScript function. Without this, the `generationsLimit` default (50) is a placeholder. | PM + Architect | Must resolve before billing epic ships |
| R2 | **Subscription price (exact amount)** — the PRD's €9–15 range needs to narrow before the billing page is built. | PM | Must resolve before billing page ships |
| R3 | **LCOV output path discovery** — projects can configure a custom `coverageDirectory` in Jest config or `outputFile` in Vitest. The `TypeScriptAdapter` must read these configs to find the LCOV file; this is implementation-level detail but has edge cases (monorepos, nested configs). | Developer | No, but surface area to test thoroughly |
| R4 | **Monorepo workspace detection** — Marcus's project might be a pnpm/Yarn/Nx workspace. Running `jest --coverage` at the root may not produce per-package LCOV files. v1 scope is a single-root project; monorepo support is explicitly out of scope, but the extension should detect this and show a clear "monorepo not yet supported" message rather than silently failing. | Developer | No |
| R5 | **Claude output quality validation** — the `TypeScriptStrategy` prompt needs iteration against a representative set of TypeScript functions before launch. If haiku quality proves insufficient, the fallback is claude-sonnet — same API, higher cost, requires re-running the cap/pricing model. | Developer | No, but must validate before public launch |
| R6 | **VS Code Marketplace review timeline** — first-time extension submissions can take days. Plan for this in the launch timeline. | Developer | No, but time-sensitive |
| R7 | **Clerk pricing at scale** — Clerk's free tier covers ~10,000 MAU. At 500 installs with some churn, this is fine. Revisit if growth exceeds projections. | PM | No |
