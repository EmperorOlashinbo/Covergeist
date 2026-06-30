# Covergeist — Developer Setup Guide

## Prerequisites

| Tool | Minimum version | Install |
|------|----------------|---------|
| Node.js | 20 | [nodejs.org](https://nodejs.org) |
| pnpm | 9 | `npm install -g pnpm` |
| Git | any | — |
| VS Code | 1.90 | [code.visualstudio.com](https://code.visualstudio.com) |

---

## 1. Clone and install

```bash
git clone https://github.com/covergeist/covergeist.git
cd covergeist
pnpm install
```

This installs all three workspace packages (`extension/`, `backend/`, `shared/`) in one step.

---

## 2. Set up external services

You need accounts on four services. All offer free tiers sufficient for local development.

### Neon (PostgreSQL database)

1. Create a project at [console.neon.tech](https://console.neon.tech)
2. In the project dashboard, open **Connection Details**
3. Copy the **Connection string** — it looks like:
   `postgresql://user:password@host/dbname?sslmode=require`

### Clerk (authentication)

1. Create an application at [dashboard.clerk.com](https://dashboard.clerk.com)
2. Go to **API Keys**. You need:
   - **Publishable key** — starts with `pk_test_…` or `pk_live_…`
   - **JWKS URL** — listed under API Keys as "JWKS URL", looks like:
     `https://your-instance.clerk.accounts.dev/.well-known/jwks.json`
3. Go to **Domains** to find your **Frontend API URL**, e.g.:
   `https://your-instance.clerk.accounts.dev`
4. **Add the redirect URI** for the VS Code auth callback:
   - In Clerk dashboard → **Redirects** (or OAuth applications) → add:
     `vscode://covergeist.covergeist/auth`
5. **JWT template** — Clerk's default JWTs include `sub` (the Clerk user ID) but not `email_address`. The backend auth middleware looks for `email_address` first, then `email`. To include email in every JWT, go to **JWT Templates** → edit the session token template and add:
   ```json
   {
     "email_address": "{{user.primary_email_address}}"
   }
   ```

### Stripe (billing)

1. Open the [Stripe dashboard](https://dashboard.stripe.com) → **Developers → API keys**
2. Copy the **Secret key** — starts with `sk_test_…` (use test mode for local development)
3. For webhooks: **Developers → Webhooks → Add endpoint**
   - Endpoint URL: `https://<your-tunnel>/v1/webhooks/stripe` (see [Local webhook testing](#local-webhook-testing) below)
   - Events to listen for: `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`
   - After saving, copy the **Signing secret** — starts with `whsec_…`

### Anthropic (LLM)

1. Generate an API key at [console.anthropic.com](https://console.anthropic.com) → **API Keys**
2. Copy the key — starts with `sk-ant-…`

---

## 3. Configure environment variables

```bash
cp .env.example backend/.env
```

Open `backend/.env` and fill in the values from step 2:

```env
DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require

CLERK_SECRET_KEY=sk_test_...
CLERK_JWKS_URL=https://your-instance.clerk.accounts.dev/.well-known/jwks.json

STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

ANTHROPIC_API_KEY=sk-ant-...

PORT=3000
```

> The `.env` file is gitignored. Never commit it.

---

## 4. Run database migrations

```bash
pnpm --filter @covergeist/backend db:migrate
```

This runs the Drizzle migration in `backend/drizzle/` and creates three tables in your Neon database: `users`, `subscriptions`, `generation_log`.

To regenerate migrations after schema changes:

```bash
pnpm --filter @covergeist/backend db:generate
```

---

## 5. Start the backend

```bash
pnpm --filter @covergeist/backend dev
```

The server starts on `http://localhost:3000`. Verify it's running:

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

The `dev` script uses `ts-node` and does **not** watch for file changes. Kill and restart after edits. For a compiled build:

```bash
pnpm --filter @covergeist/backend build
pnpm --filter @covergeist/backend start
```

---

## 6. Run the extension in development

The extension runs inside a VS Code **Extension Development Host** — a sandboxed VS Code window.

1. Open the `covergeist` folder in VS Code
2. Press **F5** (or **Run → Start Debugging**)
   - This compiles the extension and opens a new VS Code window with it loaded
   - The debug console in the original window shows extension logs
3. In the Extension Development Host window, open any TypeScript/JavaScript project

To recompile after changes: **Ctrl+Shift+F5** (Restart) or just save — if you have the TypeScript watcher running.

---

## 7. Configure the extension for local development

The extension's default `apiUrl` points to `https://api.covergeist.dev`. For local development, override it in VS Code settings.

Open **File → Preferences → Settings** (or `Ctrl+,`) and search for `covergeist`. Set:

| Setting | Local dev value |
|---------|----------------|
| `covergeist.apiUrl` | `http://localhost:3000` |
| `covergeist.clerkPublishableKey` | your `pk_test_…` key |
| `covergeist.clerkFrontendApiUrl` | `https://your-instance.clerk.accounts.dev` |
| `covergeist.billingUrl` | `https://billing.stripe.com/p/login/test_…` (optional) |

Or add them directly to your workspace's `.vscode/settings.json`:

```json
{
  "covergeist.apiUrl": "http://localhost:3000",
  "covergeist.clerkPublishableKey": "pk_test_...",
  "covergeist.clerkFrontendApiUrl": "https://your-instance.clerk.accounts.dev"
}
```

---

## 8. Local webhook testing

Stripe cannot reach `localhost`. Use a tunnel to forward webhook events during local development.

**With the Stripe CLI (recommended):**

```bash
stripe listen --forward-to localhost:3000/v1/webhooks/stripe
```

The CLI prints a webhook signing secret (`whsec_…`) — use that as `STRIPE_WEBHOOK_SECRET` in your `.env` (overrides the one from the dashboard). Restart the backend after updating `.env`.

**With ngrok:**

```bash
ngrok http 3000
```

Copy the HTTPS URL, register it as a Stripe webhook endpoint (see step 2 above), and update `STRIPE_WEBHOOK_SECRET`.

---

## 9. Run tests

```bash
# Shared package
pnpm --filter @covergeist/shared test

# Backend (unit + integration)
pnpm --filter @covergeist/backend test

# Backend with coverage report
pnpm --filter @covergeist/backend test:coverage

# Watch mode (backend)
pnpm --filter @covergeist/backend test:watch
```

Tests use **Vitest 4.1.9**. The VS Code extension is excluded — it requires `@vscode/test-electron` and a full VS Code runtime.

---

## 10. Type checking

```bash
# All packages
pnpm typecheck

# Single package
pnpm --filter @covergeist/backend typecheck
pnpm --filter @covergeist/extension typecheck
pnpm --filter @covergeist/shared typecheck
```

---

## 11. Build everything

```bash
pnpm build
```

This runs `tsc` in all three packages. Outputs:

| Package | Output |
|---------|--------|
| `shared/` | `shared/dist/` |
| `backend/` | `backend/dist/` |
| `extension/` | `extension/dist/extension.js` |

---

## 12. Package the extension

```bash
pnpm --filter covergeist package
```

Produces a `.vsix` file in `extension/`. Install it manually with:

```bash
code --install-extension covergeist-0.1.0.vsix
```

Requires `@vscode/vsce` (already in devDependencies).

---

## Project structure

```
covergeist/
├── shared/          # Zod schemas shared by extension and backend
├── backend/         # Fastify API server
│   ├── src/
│   │   ├── db/      # Drizzle client and schema
│   │   ├── llm/     # AnthropicClient, TypeScriptStrategy
│   │   ├── middleware/  # auth, quota
│   │   └── routes/  # generate, quota, subscription, webhooks/stripe
│   └── drizzle/     # Generated SQL migrations
└── extension/       # VS Code extension
    └── src/
        ├── adapters/    # LanguageAdapter, TypeScriptAdapter, AdapterRegistry
        ├── api/         # BackendClient
        ├── auth/        # AuthService (PKCE + SecretStorage)
        ├── coverage/    # CoverageService, DecorationProvider, CoverageSummaryProvider
        ├── generation/  # GenerationService, GenerateTestCodeActionProvider, DiffService
        └── quota/       # QuotaService
```

---

## Common issues

**`Error: DATABASE_URL is not set`**
The backend reads `process.env.DATABASE_URL` at startup. Make sure `backend/.env` exists and is populated, and that you're running the server from the `backend/` directory context (pnpm handles this automatically).

**`TypeError: Invalid URL` in auth middleware**
`CLERK_JWKS_URL` is missing or malformed in `.env`. The URL must be a valid HTTPS URL pointing to Clerk's JWKS endpoint.

**Extension can't reach the backend (`backend unreachable`)**
Check that `covergeist.apiUrl` is set to `http://localhost:3000` in VS Code settings and the backend is running. CORS is locked to `origin: false` — requests from the extension (not a browser) bypass CORS, so this is not a CORS issue.

**Stripe webhook signature verification fails**
When using `stripe listen`, the signing secret printed by the CLI is different from the one in the Stripe dashboard. Use the CLI secret in your `.env` during local development.
