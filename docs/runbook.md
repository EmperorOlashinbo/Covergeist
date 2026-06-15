# Covergeist — Operations Runbook

## Services at a glance

| Service | Platform | URL / location |
|---|---|---|
| Backend API | Railway | `https://api.covergeist.com` (configure custom domain in Railway) |
| Database | Neon | Neon console → project "covergeist" |
| Auth | Clerk | Clerk dashboard → application "covergeist" |
| Billing | Stripe | Stripe dashboard → account |
| LLM | Anthropic | Anthropic console → API keys |
| Extension | VS Code Marketplace | Publisher: covergeist |
| Source | GitHub | `github.com/EmperorOlashinbo/Covergeist` |

---

## First-time setup (one-time, manual steps)

These steps require human accounts. Complete them before any deployment.

### 1. Neon — create the database

1. Sign up at https://neon.tech
2. Create a project named **covergeist**
3. Copy the connection string (includes host, user, password, dbname)
4. Add to Railway as `DATABASE_URL` (see §3 below)

### 2. Clerk — create the auth application

1. Sign up at https://clerk.com
2. Create an application named **covergeist**
3. In **API Keys**, copy:
   - **Secret key** → `CLERK_SECRET_KEY`
   - **JWKS URL** (under Domains or API Keys) → `CLERK_JWKS_URL`
4. In **Redirect URLs**, add: `vscode://covergeist/auth`
5. Add both keys to Railway (see §3 below)

### 3. Railway — create the backend service

1. Sign up at https://railway.com
2. Create a new project → **Deploy from GitHub repo** → select `EmperorOlashinbo/Covergeist`
3. Railway will detect `railway.toml` and auto-configure the build
4. In the service settings, add all environment variables from `.env.example`:
   - `DATABASE_URL`
   - `CLERK_SECRET_KEY`
   - `CLERK_JWKS_URL`
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `ANTHROPIC_API_KEY`
5. Copy the **Railway service token** from your account settings
6. Add to GitHub repo secrets as `RAILWAY_TOKEN`:
   - GitHub repo → Settings → Secrets and variables → Actions → New secret

### 4. Stripe — configure billing

1. Sign up at https://stripe.com
2. In **Developers → API keys**, copy the **Secret key** → `STRIPE_SECRET_KEY`
3. In **Developers → Webhooks**, add an endpoint:
   - URL: `https://api.covergeist.com/v1/webhooks/stripe`
   - Events: `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`
4. Copy the **Signing secret** → `STRIPE_WEBHOOK_SECRET`

### 5. Anthropic — get the API key

1. Sign up at https://console.anthropic.com
2. Create an API key → `ANTHROPIC_API_KEY`

### 6. VS Code Marketplace — register publisher

1. Sign in at https://marketplace.visualstudio.com/manage
2. Create publisher: **covergeist**
3. Generate a Personal Access Token (PAT) with **Marketplace → Manage** scope
4. Add to GitHub repo secrets as `VSCE_PAT`

---

## Deploying the backend

### Automatic (normal path)

Push to `main`. The `deploy.yml` workflow runs automatically when files in `backend/`, `shared/`, or `railway.toml` change. Railway redeploys within ~2 minutes.

```
git push origin main
```

Watch the deploy: GitHub → Actions → "Deploy backend to Railway"
Watch Railway logs: Railway dashboard → your service → Logs

### Manual deploy (emergency)

```bash
npm install -g @railway/cli
railway login
railway up --service covergeist-backend
```

### Verify the deploy

```bash
curl https://api.covergeist.com/health
# expected: {"status":"ok"}
```

---

## Rolling back the backend

### Via Railway dashboard (fastest)

1. Railway → your service → **Deployments**
2. Find the last known-good deploy
3. Click **Rollback** → confirm

The previous image is redeployed in under a minute. No code change required.

### Via git revert (auditable)

```bash
git revert HEAD --no-edit
git push origin main
# CI runs, Railway redeploys the reverted code
```

---

## Publishing the extension

Publishing is **manual and irreversible** (a version once published cannot be unpublished, only superseded).

1. GitHub → Actions → **Publish VS Code extension** → **Run workflow**
2. Choose version bump: `patch` / `minor` / `major`
3. Confirm — the workflow builds, bumps `extension/package.json`, and pushes to the Marketplace

**Before publishing, verify:**
- All acceptance criteria for all shipped stories are verified (QA approved)
- `vsce package` produces a clean `.vsix` with no warnings
- The version in `extension/package.json` is correct

---

## Where secrets live

| Secret | Lives in | Never in |
|---|---|---|
| `DATABASE_URL` | Railway env vars | Code, logs, `.env` committed |
| `CLERK_SECRET_KEY` | Railway env vars | Code, logs |
| `CLERK_JWKS_URL` | Railway env vars | Code |
| `STRIPE_SECRET_KEY` | Railway env vars | Code, logs |
| `STRIPE_WEBHOOK_SECRET` | Railway env vars | Code, logs |
| `ANTHROPIC_API_KEY` | Railway env vars | Code, logs |
| `RAILWAY_TOKEN` | GitHub Actions secret | Code, `.env` |
| `VSCE_PAT` | GitHub Actions secret | Code, `.env` |
| Extension refresh token | VS Code SecretStorage (user's OS keychain) | Disk, logs, network |

**Rule:** `.env` is gitignored. `.env.example` has placeholder values only. No secret ever touches source control.

---

## Logs

| What | Where |
|---|---|
| Backend runtime logs | Railway dashboard → service → Logs |
| Backend deploy logs | Railway dashboard → service → Deployments |
| CI/CD logs | GitHub → Actions |
| Extension errors | VS Code → Help → Toggle Developer Tools → Console |

**Note on privacy:** The backend is configured to exclude request bodies from logs on `POST /v1/generate`. Code snippets never appear in Railway logs.

---

## Known issue: `.gitIgnore` vs `.gitignore`

The repo contains two ignore files:
- `.gitIgnore` (capital I) — tracked, BMAD-generated, but **not used by git on Linux** (case-sensitive filesystem)
- `.gitignore` (lowercase) — created in Story 1.1, **used by git**, excludes `.env`, `node_modules`, `dist`, `*.vsix`, `coverage`

Git on Linux only reads the lowercase `.gitignore`. The uppercase file has no effect on what git tracks or ignores. All secrets (`.env`) are safely excluded by the lowercase file. The uppercase file can be removed if desired — it does not affect git behaviour.

---

## Database migrations

Drizzle migrations are not yet configured (Story 2.1 scope). When the time comes:

```bash
pnpm --filter @covergeist/backend drizzle-kit migrate
```

Run against a staging database before production. Never run untested migrations directly against production.
