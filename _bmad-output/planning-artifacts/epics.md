---
stepsCompleted: [step-01, step-02, step-03, step-04]
inputDocuments:
  - docs/prd.md
  - docs/architecture.md
---

# Covergeist - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for Covergeist, decomposing the requirements from the PRD and Architecture into implementable stories.

## Requirements Inventory

### Functional Requirements

FR1: The extension must automatically detect whether a project uses Jest or Vitest by reading package.json, without requiring manual configuration.
FR2: The extension must provide a command (via command palette and sidebar button) to trigger a coverage scan on the open workspace.
FR3: The extension must decorate uncovered lines and functions inline with gutter icons and/or line highlights ("haunted" indicators).
FR4: The extension must display a coverage summary panel showing percentage covered per file.
FR5: Coverage decorations must refresh after the developer accepts a generated test or re-runs a scan manually.
FR6: The extension must cache the last coverage result within the session to avoid re-triggering a full scan on every file tab change.
FR7: A "Generate test" action must be available on any haunted function or block via gutter icon click or VS Code code action.
FR8: Generated tests must target the project's detected test runner (Jest or Vitest).
FR9: The extension must display a diff panel preview of the generated test before writing it to disk.
FR10: The developer must be able to accept the generated test with one click, causing it to be written to the appropriate test file.
FR11: The developer must be able to reject the generated test with one click, leaving the workspace unchanged.
FR12: Only the selected function's code snippet and its immediate context (not the full project) may be transmitted to the backend.
FR13: All detection features must be available without creating an account.
FR14: The extension must prompt for account sign-in only when the developer first attempts to generate a test.
FR15: The developer's session must persist across VS Code restarts using VS Code SecretStorage.
FR16: A subscribed developer must be able to see their remaining generation quota in the VS Code status bar or sidebar.
FR17: The extension must show a clear upgrade prompt (opening the subscription page in the browser) when the monthly generation limit is reached.
FR18: The developer must be able to manage their subscription via a web page outside the extension (browser redirect only).
FR19: The extension must automatically reflect subscription status changes without requiring a restart.
FR20: Coverage detection and test generation must be implemented behind a pluggable adapter interface (one adapter per language).
FR21: The TypeScript/JavaScript adapter must be the sole adapter shipped in v1.

### NonFunctional Requirements

NFR1: Only the code snippet for the selected function and its immediate surrounding context may be transmitted to the backend. The full project codebase must never leave the developer's machine.
NFR2: A coverage scan on a project of up to 200 source files must complete within 30 seconds on a typical developer machine.
NFR3: Inline decorations must appear within 2 seconds of scan completion.
NFR4: A test generation response must be returned and displayed within 15 seconds under normal backend load.
NFR5: If generation takes longer than expected, the extension must show a visible in-progress indicator (not a silent wait).
NFR6: The extension must not crash or destabilise VS Code; all backend errors must surface as non-blocking notifications.
NFR7: All detection features must work without an internet connection.
NFR8: Generation must fail clearly with a "backend unreachable" message when offline.
NFR9: The extension must meet all VS Code Marketplace publication requirements.

### Additional Requirements

- Monorepo structure: pnpm workspaces with three packages — extension/, backend/, shared/
- Shared Zod schemas in shared/ package for type safety between extension and backend
- Backend framework: Fastify with Zod schema validation on all routes; CORS and rate-limiter plugins
- Database: Neon (PostgreSQL) with Drizzle ORM; tables: users, subscriptions, generation_log
- Auth: Clerk PKCE flow; refresh token stored in VS Code SecretStorage; backend verifies JWTs via Clerk JWKS endpoint (1-hour cache TTL); user row upserted on first verified JWT
- Billing: Stripe; webhook-driven subscription sync (customer.subscription.updated/deleted, invoice.payment_failed); extension opens browser URL only, never calls Stripe directly
- LLM: Anthropic Claude claude-haiku-3-5; max_tokens: 1024; 12-second client timeout; no code persisted on backend
- Deployment: Railway (backend auto-deploy from main), VS Code Marketplace (extension, manual vsce publish)
- Coverage execution: spawn test runner as child process with 60-second hard timeout; LCOV as canonical format, Istanbul JSON as fallback
- Rate limiting: per-IP and per-user limits on the generate endpoint (defence-in-depth alongside quota middleware)
- Quota enforcement: server-side only via QuotaMiddleware; runs before LLM call so quota-exceeded requests never reach Anthropic
- Privacy: no request body logging on the generate route; generation_log stores no code content (counter rows only)
- Folder structure per architecture: extension/src/{adapters,coverage,generation,auth,quota,api}, backend/src/{routes,middleware,generation,llm,db}

### UX Design Requirements

N/A — No UX design document exists for this project. This is a VS Code extension with no custom web UI beyond the Marketplace listing.

### FR Coverage Map

FR1: Epic 1 - Runner auto-detection from package.json
FR2: Epic 1 - Coverage scan trigger (command palette + sidebar)
FR3: Epic 1 - Inline haunted decorations (gutter icons + line highlights)
FR4: Epic 1 - Coverage summary panel per file
FR5: Epic 1 - Decoration refresh after scan/accept
FR6: Epic 1 - Session coverage cache
FR7: Epic 3 - "Generate test" code action on haunted code
FR8: Epic 3 - Runner-targeted test output (Jest or Vitest)
FR9: Epic 3 - Diff panel preview before write to disk
FR10: Epic 3 - Accept generated test → written to test file
FR11: Epic 3 - Reject generated test → no side effects
FR12: Epic 3 - Snippet-only transmission (privacy guarantee)
FR13: Epic 1 - Detection requires no account
FR14: Epic 2 - Sign-in prompt only at first generation attempt
FR15: Epic 2 - Session persists across restarts (SecretStorage)
FR16: Epic 2 - Quota display in status bar/sidebar
FR17: Epic 2 - Upgrade prompt when limit reached → browser
FR18: Epic 2 - Web-based subscription management (browser redirect only)
FR19: Epic 2 - Auto subscription status refresh without restart
FR20: Epic 1 - Pluggable adapter interface
FR21: Epic 1 - TypeScript/JS adapter sole implementation in v1

## Epic List

### Epic 1: Free Coverage Detection
A developer can install Covergeist, run a coverage scan on their TypeScript/JavaScript project, and see uncovered ("haunted") code highlighted inline in VS Code — entirely free, with no account required.
**FRs covered:** FR1, FR2, FR3, FR4, FR5, FR6, FR13, FR20, FR21

### Epic 2: Authentication, Subscription & Billing
A developer can sign in to Covergeist via browser, have their session persist across restarts, see their remaining generation quota in VS Code, open the billing page to upgrade, and have the extension automatically reflect subscription status changes without restarting.
**FRs covered:** FR14, FR15, FR16, FR17, FR18, FR19

### Epic 3: AI Test Generation
A subscribed developer can click "Generate test" on any haunted function, review the AI-generated Jest or Vitest test in a diff panel, and accept it with one click — knowing only their code snippet (not their full project) was sent to the backend.
**FRs covered:** FR7, FR8, FR9, FR10, FR11, FR12

---

## Epic 1: Free Coverage Detection

A developer can install Covergeist, run a coverage scan on their TypeScript/JavaScript project, and see uncovered ("haunted") code highlighted inline in VS Code — entirely free, with no account required.

### Story 1.1: Monorepo Scaffold & Extension Activation — Status: DONE

As a Covergeist developer,
I want the pnpm monorepo scaffold with VS Code extension entry point set up,
So that there is a working foundation on which all features can be built.

**Acceptance Criteria:**

**Given** the repo is checked out, **When** `pnpm install` runs at the workspace root, **Then** all three packages (extension/, backend/, shared/) install without errors.

**Given** the shared package, **When** imported by extension or backend, **Then** all Zod schemas (CodeSnippetSchema, GenerateRequestSchema, GenerateResponseSchema, QuotaResponseSchema, SubscriptionResponseSchema) from architecture §4.4 are available and correctly typed.

**Given** the extension is installed in VS Code, **When** VS Code opens a workspace, **Then** the extension activates without errors and displays "Covergeist" in the status bar.

**Given** the extension is active, **When** VS Code closes, **Then** the extension deactivates cleanly with no errors or leaked resources.

**Given** the extension's package.json, **When** `vsce package` runs, **Then** a valid .vsix file is produced meeting VS Code Marketplace requirements (NFR9).

### Story 1.2: Language Adapter Interface & Runner Detection — Status: DONE

As a developer working on a TypeScript project,
I want Covergeist to automatically detect whether my project uses Jest or Vitest by reading package.json,
So that I don't need to configure anything manually.

**Acceptance Criteria:**

**Given** the LanguageAdapter interface and AdapterRegistry are defined per architecture §4.1 and §4.3, **When** `AdapterRegistry.resolve(projectRoot)` is called on a TypeScript/JavaScript project, **Then** it returns the TypeScriptAdapter instance.

**Given** a workspace with `typescript` or `ts-jest` in devDependencies or `.ts`/`.js` source files, **When** `TypeScriptAdapter.canHandle(projectRoot)` is called, **Then** it returns `true`.

**Given** a workspace with no TypeScript/JavaScript indicators, **When** `canHandle()` is called, **Then** it returns `false`.

**Given** a project with `jest` in devDependencies or scripts, **When** `detectRunner(projectRoot)` is called, **Then** it returns `'jest'`.

**Given** a project with `vitest` in devDependencies or scripts, **When** `detectRunner(projectRoot)` is called, **Then** it returns `'vitest'`.

**Given** a project with both Jest and Vitest present, **When** `detectRunner()` is called, **Then** it returns `'jest'` (Jest takes precedence per architecture ADR).

**Given** a project with neither Jest nor Vitest, **When** `detectRunner()` is called, **Then** it returns `null`.

**Given** `resolveTestFilePath('src/pricing/discount.ts', projectRoot)`, **When** no `__tests__` directory exists at that level, **Then** it returns `'src/pricing/discount.test.ts'`. **And** when a `__tests__` directory exists at the same level, it returns `'src/__tests__/discount.test.ts'`.

### Story 1.3: Coverage Scan Execution & Result Caching — Status: DONE

As a developer,
I want to trigger a coverage scan from VS Code and have results cached for the session,
So that I can see which code is untested without leaving the editor and without re-scanning on every file switch.

**Acceptance Criteria:**

**Given** a TypeScript project with Jest configured, **When** the user runs `covergeist.runScan`, **Then** the extension spawns `npx jest --coverage --passWithNoTests` in the workspace root and waits for the process to complete.

**Given** a TypeScript project with Vitest configured, **When** the user runs `covergeist.runScan`, **Then** the extension spawns `npx vitest run --coverage` in the workspace root.

**Given** the coverage command completes, **When** an LCOV file is found at the project's configured output path (defaulting to `coverage/lcov.info`), **Then** `parseCoverage()` returns a CoverageMap with correct per-line and per-function boolean coverage for all files in the report.

**Given** the scan takes longer than 30 seconds, **When** the threshold is crossed, **Then** a non-blocking warning notification appears: "Coverage scan is taking longer than expected — your test suite may be slow."

**Given** the scan exceeds 60 seconds, **When** the hard timeout fires, **Then** the child process is terminated and a non-blocking error notification appears.

**Given** a coverage scan completes successfully, **When** the user switches between open files, **Then** no new spawn is triggered — the cached CoverageMap is served.

**Given** `covergeist.runScan` is triggered again, **When** the new scan completes, **Then** the cached CoverageMap is replaced with the fresh result and all listening providers are notified.

**Given** `covergeist.runScan` is run on a project with no Jest/Vitest configured, **When** the command executes, **Then** a non-blocking notification appears: "No supported test runner detected. Configure Jest or Vitest in your project."

### Story 1.4: Inline Haunted Decorations — Status: DONE

As a developer,
I want uncovered lines and functions highlighted inline in my editor with haunted indicators,
So that I can see coverage gaps in context while reading my code.

**Acceptance Criteria:**

**Given** a completed coverage scan, **When** the developer opens a TypeScript or JavaScript file, **Then** uncovered lines display a gutter icon (haunted icon) and a faint line background highlight. **And** covered lines show no decoration.

**Given** a file with no coverage data in the CoverageMap, **When** the developer opens it, **Then** no decorations are applied.

**Given** decorations are applied from a fresh scan, **When** they appear, **Then** they render within 2 seconds of the scan completing (NFR3).

**Given** the scan cache is refreshed (re-scan completes), **When** the user is viewing a file, **Then** existing decorations are cleared and replaced with the updated results within 2 seconds.

**Given** the extension is offline, **When** the developer opens VS Code, **Then** detection features including cached decorations still work — no network call is made for decoration (NFR7).

**Given** an unhandled error occurs in DecorationProvider, **When** it is thrown, **Then** the extension catches it, shows a non-blocking notification, and VS Code remains stable (NFR6).

### Story 1.5: Coverage Summary Panel — Status: DONE

As a developer,
I want a sidebar panel showing percentage covered per file,
So that I can assess my project's overall coverage health at a glance.

**Acceptance Criteria:**

**Given** a completed coverage scan, **When** the developer opens the Covergeist sidebar view, **Then** all files from the CoverageMap are listed with their line coverage percentage (e.g. "src/pricing/discount.ts — 42%").

**Given** no scan has been run yet, **When** the developer opens the sidebar panel, **Then** the panel shows "Run a scan to see coverage" and a button or link to trigger `covergeist.runScan`.

**Given** the summary panel is open during a re-scan, **When** the new scan completes, **Then** the panel updates automatically with the fresh results.

**Given** a file with 100% coverage, **When** shown in the panel, **Then** it is visually distinguished from partially or uncovered files (e.g. a different icon or colour).

---

## Epic 2: Authentication, Subscription & Billing

A developer can sign in to Covergeist via browser, have their session persist across restarts, see their remaining generation quota in VS Code, open the billing page to upgrade, and have the extension automatically reflect subscription status changes without restarting.

### Story 2.1: Backend Scaffold, Auth Middleware & Subscription Routes — Status: DONE

As a Covergeist developer,
I want a deployed backend service with Clerk JWT verification and subscription/quota endpoints,
So that the extension can verify user identity and check subscription status.

**Acceptance Criteria:**

**Given** the backend is deployed to Railway, **When** `GET /health` is called, **Then** it returns `200 { status: "ok" }`.

**Given** a valid Clerk JWT in the `Authorization: Bearer` header, **When** any protected route is called, **Then** `AuthMiddleware` verifies the JWT against Clerk's JWKS endpoint (cached with a 1-hour TTL) and attaches `clerkId` to the request.

**Given** an invalid or missing JWT, **When** a protected route is called, **Then** the backend returns `401 { error: "unauthorized" }`.

**Given** a valid JWT for a user not yet in the `users` table, **When** any protected route is called, **Then** a `users` row is upserted with `clerkId` and `email` from the JWT claims.

**Given** the `users` and `subscriptions` tables exist per architecture §5, **When** `GET /v1/subscription` is called with a valid JWT for a subscribed user, **Then** it returns `{ status: "active", currentPeriodEnd: "<ISO datetime>" }`.

**Given** a user with no row in `subscriptions`, **When** `GET /v1/subscription` is called, **Then** it returns `{ status: "none", currentPeriodEnd: null }`.

**Given** a user with an active subscription, **When** `GET /v1/quota` is called, **Then** it returns `{ used: N, limit: M, resetAt: "<ISO datetime>" }` where `used` is the count of `generation_log` rows for `(userId, billingPeriodStart)`.

**Given** a user with no active subscription, **When** `GET /v1/quota` is called, **Then** it returns `403 { error: "no_subscription" }`.

**Given** the `generation_log` table exists per architecture §5, **When** the backend starts, **Then** the table is present and queryable (no inserts made in this story — that belongs to Epic 3).

### Story 2.2: Extension Auth Flow & Session Persistence — Status: DONE

As a developer,
I want to sign in to Covergeist via my browser and have my session persist across VS Code restarts,
So that I only need to authenticate once.

**Acceptance Criteria:**

**Given** the user has no active session, **When** `AuthService.signIn()` is called, **Then** a Clerk PKCE authorization URL is opened in the default browser via `vscode.env.openExternal`.

**Given** the user completes auth in the browser, **When** Clerk redirects to `vscode://publisher.covergeist/auth`, **Then** VS Code fires the registered `UriHandler`, the extension exchanges the authorization code for tokens, and the user is signed in.

**Given** a successful token exchange, **When** the refresh token is received, **Then** it is stored in `vscode.SecretStorage` and never written to disk in plaintext (FR15).

**Given** VS Code is restarted, **When** the extension activates, **Then** it reads the refresh token from SecretStorage and silently refreshes the access token — the user is not prompted to sign in again (FR15).

**Given** the access token has expired, **When** `AuthService.getAccessToken()` is called, **Then** it transparently uses the refresh token to obtain a new access token and returns it without user interaction.

**Given** the user runs `covergeist.signOut`, **When** the command executes, **Then** the refresh token is removed from SecretStorage and the in-memory access token is cleared.

**Given** `BackendClient` makes any API request, **When** called, **Then** it attaches `Authorization: Bearer <token>` using `AuthService.getAccessToken()`.

**Given** the backend returns `401`, **When** `BackendClient` receives it, **Then** it attempts one silent token refresh and retries the request once before surfacing a non-blocking "Session expired — please sign in" notification.

### Story 2.3: Quota Display, Upgrade Flow & Stripe Webhooks

As a subscribed developer,
I want to see my remaining generation quota in VS Code and be able to open the billing page when I need to upgrade,
So that I can manage my usage and continue generating tests without interruption.

**Acceptance Criteria:**

**Given** an active session and subscription, **When** the extension activates, **Then** `QuotaService` calls `GET /v1/quota` and the VS Code status bar shows "Covergeist: N generations left" (FR16).

**Given** a user with no active subscription, **When** `QuotaService` polls `GET /v1/quota` and receives `403`, **Then** the status bar shows "Covergeist: Subscribe to generate tests".

**Given** a subscribed developer has reached their monthly generation cap, **When** they attempt to generate a test, **Then** a non-blocking notification appears: "You've used all your generations this month. Upgrade to continue." with an "Upgrade" button (FR17).

**Given** the developer clicks "Upgrade", **When** the button is clicked, **Then** `vscode.env.openExternal` opens the Covergeist subscription URL in the browser (FR18).

**Given** the developer has clicked "Upgrade" and the billing page is open, **When** `QuotaService` starts its polling cycle (every 10 seconds, up to 5 minutes), **Then** it polls `GET /v1/subscription` until status becomes `'active'`.

**Given** the subscription becomes `'active'` (detected via polling), **When** `QuotaService` detects the change, **Then** the status bar updates to show remaining quota and any upgrade notification is dismissed — without requiring a VS Code restart (FR19).

**Given** Stripe fires a `customer.subscription.updated` event with a valid `Stripe-Signature`, **When** `POST /v1/webhooks/stripe` receives it, **Then** the `subscriptions` row is upserted with the new `status` and `currentPeriodEnd`.

**Given** Stripe fires a `customer.subscription.deleted` event, **When** received, **Then** the `subscriptions` row `status` is set to `'canceled'`.

**Given** Stripe fires an `invoice.payment_failed` event, **When** received, **Then** the `subscriptions` row `status` is set to `'past_due'`.

**Given** a webhook request with an invalid `Stripe-Signature`, **When** received, **Then** the backend returns `400` immediately without processing the event body.

---

## Epic 3: AI Test Generation

A subscribed developer can click "Generate test" on any haunted function, review the AI-generated Jest or Vitest test in a diff panel, and accept it with one click — knowing only their code snippet (not their full project) was sent to the backend.

### Story 3.1: Snippet Extraction & Generate Test Code Action

As a developer,
I want a "Generate test" action on any haunted function that checks my auth and subscription before proceeding,
So that I can request a test without navigating away from my code.

**Acceptance Criteria:**

**Given** a file with haunted decorations applied, **When** the developer clicks the haunted gutter icon or invokes VS Code code actions on a haunted line, **Then** a "Generate test for [functionName]" action appears in the code action menu.

**Given** the developer invokes "Generate test" with no active session, **When** the action runs, **Then** a non-blocking prompt appears: "Sign in to Covergeist to generate tests" with a "Sign In" button that calls `AuthService.signIn()` (FR14).

**Given** the developer invokes "Generate test" with a valid session but no active subscription, **When** `GenerationService` checks subscription status via `GET /v1/subscription`, **Then** a non-blocking prompt appears: "Subscribe to Covergeist to generate tests" with an "Upgrade" button.

**Given** the developer invokes "Generate test" on a function with a valid session and active subscription, **When** `TypeScriptAdapter.extractSnippet()` is called, **Then** the returned `CodeSnippet` contains: the full function body in `snippetCode`, up to 10 lines of surrounding context in `contextCode`, the correct `relativeFilePath`, the detected `runner`, and `language: 'typescript'`.

**Given** a `CodeSnippet` where `snippetCode` exceeds 8000 characters or `contextCode` exceeds 2000 characters, **When** the snippet is constructed, **Then** the values are clamped to the Zod schema maxima before transmission (FR12, architecture §4.4).

### Story 3.2: Backend Test Generation Endpoint

As a subscribed developer,
I want the backend to generate a ready-to-run Jest or Vitest test for my code snippet,
So that I receive a working test without writing it by hand.

**Acceptance Criteria:**

**Given** a valid JWT with active subscription and remaining quota, **When** `POST /v1/generate` is called with a valid `GenerateRequestSchema` body, **Then** the backend calls `TypeScriptStrategy.buildPrompt()`, sends the result to Anthropic claude-haiku-3-5, and returns `200 { test: "<clean test code>", suggestedTestFilePath: "..." }`.

**Given** `TypeScriptStrategy.buildPrompt()` is called with `runner: 'jest'`, **When** the system prompt is built, **Then** it instructs Claude to output only valid Jest TypeScript test code with no markdown fences and no prose explanations (FR8).

**Given** `TypeScriptStrategy.buildPrompt()` is called with `runner: 'vitest'`, **When** the system prompt is built, **Then** it instructs Claude to output only valid Vitest test code (using `vi.fn()` etc.) with no markdown fences and no prose explanations (FR8).

**Given** `TypeScriptStrategy.sanitiseResponse()` receives raw LLM output containing markdown code fences, **When** called, **Then** the fences are stripped and only clean TypeScript test code is returned.

**Given** `AnthropicClient` makes the API call, **When** called, **Then** `max_tokens` is set to 1024 and `temperature` is 0.

**Given** Anthropic does not respond within 12 seconds, **When** the timeout fires, **Then** `AnthropicClient` throws `LLMTimeoutError` and the route returns `504 { error: "llm_timeout" }`.

**Given** `QuotaMiddleware` runs before the LLM call, **When** the user has used all their monthly generations, **Then** the middleware returns `402 { error: "quota_exceeded", remaining: 0, resetAt: "..." }` without calling Anthropic.

**Given** the generation request succeeds, **When** the route handler completes, **Then** a row is inserted into `generation_log` with `userId` and `billingPeriodStart` — and no code content (NFR1).

**Given** the backend processes `POST /v1/generate`, **When** the route runs, **Then** `snippetCode` and `contextCode` are never written to any log or database (NFR1).

**Given** `POST /v1/generate` is called with a body that fails Zod validation, **When** received, **Then** the backend returns `400 { error: "validation_error", details: [...] }`.

### Story 3.3: Diff Preview, Accept & Reject Flow

As a developer,
I want to preview the generated test in a diff panel and accept or reject it with one click,
So that I can review AI output before it touches my codebase.

**Acceptance Criteria:**

**Given** a subscribed developer invokes "Generate test", **When** `GenerationService` sends the request to `POST /v1/generate`, **Then** a VS Code progress notification appears immediately in the status bar — not a silent wait (NFR5).

**Given** the backend returns `{ test, suggestedTestFilePath }`, **When** `GenerationService` receives the response, **Then** VS Code opens a diff editor (`vscode.diff`) with: left side = current content of `suggestedTestFilePath` (empty string if the file does not exist), right side = current content with the generated test appended (FR9).

**Given** the diff panel is open, **When** the developer clicks "Accept", **Then** the generated test is written to `suggestedTestFilePath` on disk and `covergeist.runScan` is triggered to refresh haunted decorations (FR10).

**Given** the diff panel is open, **When** the developer clicks "Reject", **Then** the diff editor is closed and no files are modified (FR11).

**Given** the developer closes the diff editor tab without explicitly accepting, **When** VS Code closes the tab, **Then** no files are modified (implicit reject).

**Given** the backend returns `402` (quota exceeded), **When** `GenerationService` receives it, **Then** the progress indicator is dismissed and a non-blocking notification appears with the quota exceeded message and an "Upgrade" button.

**Given** the backend returns `504` (LLM timeout), **When** `GenerationService` receives it, **Then** the progress indicator is dismissed and a non-blocking "Generation timed out — please try again" notification appears.

**Given** the extension is offline when generation is attempted, **When** `BackendClient` cannot reach the backend, **Then** the progress indicator is dismissed and a non-blocking "Covergeist: backend unreachable — check your connection" notification appears (NFR8).

**Given** a successful accept flow, **When** `covergeist.runScan` completes after acceptance, **Then** the haunted decoration on the accepted function is removed if the new test covers it.
