---
project_name: 'Covergeist'
user_name: 'Emperor'
date: '2026-06-15'
sections_completed: [technology_stack, language_rules, framework_rules, testing_rules, code_quality, workflow_rules, critical_rules]
status: complete
rule_count: 46
optimized_for_llm: true
---

# Project Context for AI Agents

_Critical rules and patterns AI agents must follow when implementing code in this project. Focuses on unobvious details that agents would otherwise miss._

---

## Technology Stack & Versions

- **Monorepo**: pnpm workspaces (pnpm ≥ 9, Node ≥ 20) — packages: `extension/`, `backend/`, `shared/`
- **Extension**: VS Code API ^1.90.0 · TypeScript 5.4.5 · ES2020 target · CommonJS module
- **Backend**: Fastify 4.28.1 · @fastify/cors 11.2.0 · @fastify/rate-limit 11.0.0
- **Database**: Neon serverless ^1.1.0 · Drizzle ORM 0.45.2 · drizzle-kit 0.31.10 · PostgreSQL dialect
- **Auth/Billing**: jose 6.2.3 (JWT verification) · Stripe 22.2.1
- **Shared**: Zod 3.23.8 — sole validation library; schemas live in `shared/src/schemas.ts`, exported from `shared/src/index.ts`
- **TypeScript config** (identical across all three packages): `strict: true`, `esModuleInterop: true`, `skipLibCheck: true`, `target: ES2020`, `module: commonjs`
- **LLM**: Anthropic claude-3-5-haiku-20241022 · max_tokens: 1024 · 12 s client timeout · raw `fetch` (no SDK)

## Critical Implementation Rules

### Language-Specific Rules

- **`import type` discipline**: Use `import type` for anything that is type-only. Switch to a regular `import` only when you need the value at runtime (e.g., `import * as vscode from 'vscode'` is required in `TypeScriptAdapter` because VS Code APIs are called at runtime, but `import type { AdapterRegistry }` is correct when only the type is referenced).
- **No barrel re-exports in `shared/`**: `shared/src/index.ts` re-exports everything from `schemas.ts` only. Do not add files to `shared/` without updating `index.ts`.
- **Zod inferred types, not manual interfaces**: All cross-package types (`CodeSnippet`, `GenerateRequest`, `GenerateResponse`, `QuotaResponse`, `SubscriptionResponse`) are `z.infer<typeof Schema>` from `shared/src/schemas.ts`. Never duplicate these as manual interfaces elsewhere.
- **`void` for fire-and-forget VS Code calls**: Calls to `vscode.window.showInformationMessage`, `vscode.env.openExternal`, etc. inside event handlers must be prefixed with `void` — do not `await` them if the result is unused, and do not leave them unawaited without `void` (strict TS will error).
- **`async/await` over raw Promises**: All async code uses `async/await`. Raw `.then()/.catch()` chains are not used anywhere in the project.
- **Error class naming**: Custom errors extend `Error`, set `this.name` explicitly in the constructor, and are named `XxxError` (e.g., `NetworkError`, `QuotaError`, `LLMTimeoutError`).

### Framework-Specific Rules

#### Fastify (backend)

- **Scoped plugins for content-type overrides**: `addContentTypeParser` in the Stripe webhook handler applies only to that scoped plugin — it must stay in its own `async function stripeWebhookRoutes(fastify)` registered via `fastify.register(...)`. Never add a raw-buffer parser at the top-level server instance.
- **Fastify module augmentation for request fields**: Extra fields on `FastifyRequest` (e.g., `request.user`, `request.billingPeriodStart`) must be declared via `declare module 'fastify' { interface FastifyRequest { ... } }` in the middleware file that sets them. Do not cast `request as any` instead.
- **preHandler arrays**: Auth and quota middleware are composed as `{ preHandler: [authPreHandler, quotaPreHandler] }`. Order matters — `authPreHandler` always runs first (it sets `request.user` which `quotaPreHandler` reads).
- **Route return values**: Use `return reply.status(N).send({...})` for non-200 responses and `return { ... }` for 200. Do not omit `return` before `reply.send()` — Fastify will send a double-response error.
- **No request body logging on `/v1/generate`**: The generate route must never log `request.body`, `snippet.snippetCode`, or `snippet.contextCode` — NFR1 privacy constraint.

#### VS Code Extension API

- **`withProgress` scope**: Wrap only the backend API call in `vscode.window.withProgress`, not the entire diff interaction. The progress spinner must dismiss before the diff panel opens.
- **Virtual document scheme**: The diff panel uses scheme `covergeist-diff` registered via `vscode.workspace.registerTextDocumentContentProvider`. URIs follow `covergeist-diff:/before/{stamp}` and `covergeist-diff:/after/{stamp}` patterns with a `Date.now()` stamp to avoid collisions.
- **Tab detection via `TabInputTextDiff`**: To find or close a diff tab, iterate `vscode.window.tabGroups.all` and check `tab.input instanceof vscode.TabInputTextDiff` — do not use `vscode.window.visibleTextEditors` for this (diff editors do not appear there).
- **`context.subscriptions.push`**: Every `Disposable` created during `activate()` must be pushed to `context.subscriptions`. Omitting one causes a resource leak on deactivation.
- **Code action registration**: `GenerateTestCodeActionProvider` is registered with `providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]` — this static field must match what `registerCodeActionsProvider` receives.

#### Drizzle ORM

- **Always `orderBy(desc(updatedAt)).limit(1)` for subscriptions**: The `subscriptions` table can have multiple rows per user. Always fetch the most recent one with `.orderBy(desc(subscriptions.updatedAt)).limit(1)` — omitting the order clause returns an arbitrary row.
- **Drizzle `date` columns return strings**: `subscriptions.currentPeriodStart` is a Drizzle `date()` column — it returns a `string` (YYYY-MM-DD), not a `Date`. Use it directly as a string key when querying `generationLog.billingPeriodStart`.
- **`returning()` for insert/update results**: Use `.returning({ id: table.id })` to get back the inserted/updated row ID without a separate SELECT.

### Testing Rules

- **No project-owned test files yet**: There are currently zero `.test.ts` / `.spec.ts` files in the project source. When adding tests, place them as `<name>.test.ts` co-located with the source file (e.g., `backend/src/llm/AnthropicClient.test.ts`) — not in a separate `__tests__` directory (the `resolveTestFilePath` adapter logic prefers co-location when no `__tests__` dir exists).
- **Test runner detection is runtime, not config**: The extension detects Jest vs Vitest by reading `package.json` — there is no `jest.config.js` or `vitest.config.ts` in the project. Tests generated for the extension/backend themselves should use the runner found in `devDependencies` of the relevant package.
- **LCOV is the canonical coverage format**: The coverage pipeline always writes `coverage/lcov.info`. Do not parse Istanbul JSON or any other format — `parseCoverage()` in `TypeScriptAdapter` reads LCOV only.
- **`--passWithNoTests` for Jest**: When running Jest coverage via `npx jest --coverage`, always include `--passWithNoTests` so a project with no tests yet doesn't exit with a non-zero code that aborts the scan.
- **Coverage child process always resolves**: `spawnCoverageProcess` resolves on `close` regardless of exit code — failing tests still write coverage data. Do not reject on non-zero exit.

### Code Quality & Style Rules

- **No linter/formatter config present**: There is no `.eslintrc`, `eslint.config.*`, or `.prettierrc` in the repo. TypeScript strict mode (`strict: true`) is the sole enforced quality gate. Do not introduce ESLint or Prettier config without explicit instruction.
- **PascalCase for class files**: Every file that exports a class is named after the class (e.g., `AuthService.ts`, `BackendClient.ts`, `QuotaService.ts`). Files that export only functions use camelCase (e.g., `authPreHandler` → `auth.ts`, `quotaPreHandler` → `quota.ts`).
- **Directory layout is fixed**: Do not invent new top-level directories. Extension source lives under `extension/src/{adapters,api,auth,coverage,generation,quota}/`. Backend source lives under `backend/src/{db,llm,middleware,routes}/`. Shared source is flat under `shared/src/`.
- **No comments unless the why is non-obvious**: The codebase uses comments sparingly — only to explain hidden constraints, workarounds, or non-obvious invariants (e.g., the NFR1 privacy note on the generate route, the Stripe v22 type derivation comment). Do not add explanatory comments for what the code does.
- **No unused `_variables`**: Unused catch bindings use bare `catch { }` (not `catch (_e)`). TypeScript strict mode enforces this.
- **`readonly` for injected dependencies**: Constructor parameters that should not be reassigned use `private readonly`. All service constructors in the project follow this pattern.

### Development Workflow Rules

- **Monorepo build order**: `shared/` must be built before `extension/` or `backend/` — both depend on `@covergeist/shared` via `workspace:*`. Run `pnpm -r build` from the root to build all packages in dependency order.
- **Type-check before shipping**: Each package has a `typecheck` script (`tsc --noEmit`). Run `pnpm -r typecheck` from the root to validate all three packages. There is no CI pipeline — this is the manual gate.
- **Extension packaging**: Use `pnpm --filter covergeist package` (which runs `vsce package --no-dependencies`) to produce a `.vsix`. The `--no-dependencies` flag is intentional — the extension bundles `@covergeist/shared` via the workspace.
- **Backend deployment**: Railway auto-deploys `backend/` from the `main` branch. The backend entry point is `dist/index.js` (built output of `backend/src/index.ts`). The `start` script is `node dist/index.js`.
- **Database migrations**: Use `pnpm --filter @covergeist/backend db:generate` to generate migration SQL from schema changes, then `db:migrate` to apply. Never edit generated migration files manually.
- **Environment variables**: Backend requires `DATABASE_URL`, `CLERK_JWKS_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`. Extension reads `covergeist.apiUrl`, `covergeist.clerkPublishableKey`, `covergeist.clerkFrontendApiUrl`, `covergeist.billingUrl` from VS Code settings.

### Critical Don't-Miss Rules

#### Stripe v22 Type System

- **Never use `Stripe.Event`, `Stripe.Subscription`, `Stripe.Invoice` directly**: In Stripe v22 the CJS default export (`StripeConstructor`) does not forward the `namespace Stripe` types. Derive event types with `type StripeEvent = ReturnType<typeof stripe.webhooks.constructEvent>`. For subscription/invoice data, define local interfaces (`SubData`, `InvoiceData`) and cast with `as unknown as SubData` — the fields exist at runtime but aren't in the v22 type declarations.
- **`customer.subscription.created` is not handled**: The webhook only handles `updated`, `deleted`, and `invoice.payment_failed`. The `handleSubscriptionUpsert` function covers the "no existing row" case for `created` events via a fallback insert — do not add a separate `created` handler.

#### Auth & Security

- **Clerk JWKS is cached for 1 hour**: The `createRemoteJWKSet` call in `auth.ts` uses `cacheMaxAge: 60 * 60 * 1000`. Do not make per-request JWKS fetches.
- **401 triggers one silent refresh, then fails**: `BackendClient` retries once on 401 via `authService.forceRefresh()`. If the refresh also fails, it shows "Session expired" and throws `AuthError`. Do not add more retry loops.
- **Quota middleware must run after auth middleware**: `quotaPreHandler` reads `request.user.userId` set by `authPreHandler`. Reversing the order causes a runtime crash.

#### Privacy (NFR1)

- **`snippetCode` and `contextCode` must never be logged or stored**: The generate route must not log `request.body` or any field from the snippet. `generation_log` rows store only `userId` and `billingPeriodStart` — no code content, no function names, no file paths.

#### AbortController Usage

- **One controller per operation, never reused**: `CoverageService` creates a new `AbortController` per `runScan()` call. `AnthropicClient` creates one per `generate()` call. Never share or reuse controllers across calls.
- **Always `clearTimeout` in `finally`**: The 12-second LLM timeout uses `setTimeout` + `controller.abort()`. Always `clearTimeout(timeout)` in the `finally` block to prevent the timer firing after a fast response.

#### Adapter Pattern

- **`AdapterRegistry.resolve()` returns the first matching adapter**: Adapters are checked in registration order. Currently only `TypeScriptAdapter` is registered. If adding a second adapter, register it after `TypeScriptAdapter` only if it should be a lower-priority fallback.
- **`extractSnippet` symbol provider is primary, brace-counting is fallback**: Always attempt `vscode.executeDocumentSymbolProvider` first. The `inferFunctionBounds` heuristic is only a fallback for when the symbol provider throws or returns no matching symbol.

---

## Usage Guidelines

**For AI Agents:** Read this file before implementing any code in this project. Follow all rules exactly as documented. When in doubt, prefer the more restrictive option.

**For Humans:** Keep this file lean and focused on agent needs. Update when the technology stack changes or new non-obvious patterns emerge. Remove rules that become obvious over time.

_Last Updated: 2026-06-16_
