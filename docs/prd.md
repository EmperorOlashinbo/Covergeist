# Covergeist — Product Requirements Document

> BMAD artifact: `docs/prd.md` — produced by the PM agent.
> Status: v1.0. Feeds the Architect agent.

---

## 1. Overview

Covergeist is a VS Code extension for solo developers and small TypeScript/JavaScript teams who care about test coverage but lack the time to write tests manually. It scans an open project, highlights uncovered ("haunted") code inline in the editor for free, and — for paying subscribers — generates ready-to-run Jest or Vitest tests via a cloud backend with one click. The free detection tier earns installs and trust; the paid generation tier earns revenue. No code is uploaded to a website; generation sends only the relevant snippet to the backend, keeping proprietary codebases local.

---

## 2. Goals & Success Metrics

Measured at 3 months post-launch.

| Goal | Metric | Target |
|---|---|---|
| Adoption | VS Code Marketplace installs | 500+ |
| Monetisation | Free-to-paid conversion rate | 5%+ |
| Revenue validation | Monthly recurring revenue | First €100 |

---

## 3. Personas

**Primary — Marcus, the pragmatic Node dev**
Works on a TypeScript API. Coverage sits at ~40%. He knows the gaps exist, feels guilty, but writing tests for legacy modules is tedious enough that he never starts. He wants something that closes the boring 80% for him and would pay a small monthly fee for it. He is skeptical of tools that ask for an account before showing value.

**Secondary — The credibility seeker**
A developer preparing code for a PR review, job interview, or open-source release. Coverage matters for optics as much as correctness. Wants a fast raise in coverage numbers, not a long-term workflow change. May be a one-time or short-term subscriber.

---

## 4. User Flows

### 4.1 Detection flow (free, no account)

1. Developer installs Covergeist from the VS Code Marketplace.
2. Developer opens a TypeScript or JavaScript project.
3. Extension reads `package.json`, detects whether the project uses Jest or Vitest.
4. Developer triggers a coverage scan (command palette or sidebar button).
5. Extension runs the project's existing coverage tooling locally and parses the output.
6. Uncovered lines and functions are decorated inline ("haunted" indicators — gutter icons and/or line highlights).
7. A coverage summary panel shows percentage covered per file.
8. Developer browses their code; haunted indicators are visible in context.
9. Coverage highlights update after the developer adds or accepts a test and re-runs the scan.

### 4.2 Generation flow (paid — first-time user)

1. Developer sees a haunted indicator on an uncovered function.
2. Developer clicks "Generate test" on the indicator (or via code action).
3. Because no account exists, the extension shows a prompt: "Test generation requires a Covergeist account. Sign in or create one to continue."
4. Developer signs in or registers via a browser-based auth flow.
5. Extension confirms the account and checks subscription status.
6. If not subscribed: extension shows an upgrade prompt (see §4.3). If subscribed: continue.
7. Extension sends the selected function's code snippet plus immediate surrounding context to the backend. The rest of the codebase stays local.
8. Backend returns a generated test targeting the detected runner (Jest or Vitest).
9. Extension opens a preview panel showing the generated test as a diff.
10. Developer reviews the test.
    - **Accept:** test is written to the appropriate test file in the workspace. Coverage scan re-runs to refresh haunted indicators.
    - **Reject:** nothing changes in the workspace.

### 4.3 Subscription / upgrade flow

1. Developer reaches their monthly generation cap, or attempts generation without a subscription.
2. Extension shows an in-editor notification: "You've used all X generations this month. Upgrade to continue — €[price]/month."
3. Developer clicks "Upgrade" — browser opens to the Covergeist subscription page.
4. Developer completes payment on the web.
5. Extension detects the updated subscription status and unlocks generation without requiring a restart.

---

## 5. Functional Requirements

Stories are marked **MVP** (ships in v1) or **Later** (deliberately deferred).

---

### Epic 1 — Coverage Detection (free, no account required)

**1.1** As a developer, I want Covergeist to automatically detect whether my project uses Jest or Vitest by reading `package.json`, so that I don't need to configure the extension manually. **MVP**

**1.2** As a developer, I want to trigger a coverage scan from VS Code (command palette or a sidebar button), so that I can analyse my project without leaving the editor. **MVP**

**1.3** As a developer, I want uncovered lines and functions decorated inline in my editor (gutter icon and/or line highlight), so that I can see coverage gaps in context while reading the code. **MVP**

**1.4** As a developer, I want a coverage summary panel showing the percentage covered per file in my project, so that I can assess overall health at a glance. **MVP**

**1.5** As a developer, I want coverage decorations to refresh after I accept a generated test or add a test manually and re-run the scan, so that my progress is reflected without restarting VS Code. **MVP**

**1.6** As a developer, I want the extension to cache the last coverage result, so that switching between files doesn't re-trigger a full scan on every tab change. **MVP**

---

### Epic 2 — Test Generation (paid, subscription required)

**2.1** As a developer, I want a "Generate test" action available on any haunted function or block (via gutter icon click or VS Code code action), so that I can request a test without navigating away from the code. **MVP**

**2.2** As a developer, I want the generated test to target my project's detected test runner (Jest or Vitest), so that it runs without manual adjustment. **MVP**

**2.3** As a developer, I want to preview the generated test in a diff panel before it is written to disk, so that I can review it before committing to it. **MVP**

**2.4** As a developer, I want to accept the generated test with one click, so that it is written to the appropriate test file automatically. **MVP**

**2.5** As a developer, I want to reject the generated test with one click, so that my workspace is unchanged if I don't like the output. **MVP**

**2.6** As a developer, I want only the selected function's code snippet and its immediate context transmitted to the backend — not my full project — so that proprietary code stays on my machine. **MVP**

**2.7** As a developer, I want to regenerate a test if I'm not happy with the first result, so that I get a second attempt without leaving the preview flow. **Later**

**2.8** As a developer, I want to generate tests for all haunted functions in a file at once (batch generation), so that I can close coverage gaps faster. **Later**

---

### Epic 3 — Authentication

**3.1** As a developer, I want to use all detection features without creating an account, so that I can evaluate Covergeist risk-free before any commitment. **MVP**

**3.2** As a developer, I want to be prompted to sign in or create an account only at the moment I first attempt to generate a test, so that the free tier is frictionless. **MVP**

**3.3** As a developer, I want my session to persist across VS Code restarts, so that I don't have to log in every time I use generation. **MVP**

---

### Epic 4 — Subscription & Billing

**4.1** As a subscribed developer, I want to see my remaining generation quota for the current billing cycle (e.g. in the status bar or sidebar), so that I can manage my usage and avoid unexpected cutoffs. **MVP**

**4.2** As a developer who has reached their monthly generation limit, I want a clear in-editor prompt that opens the Covergeist subscription page in my browser, so that I know exactly how to continue. **MVP**

**4.3** As a developer, I want to manage my subscription (upgrade, cancel, view invoices) on the Covergeist website, so that billing is handled securely outside the extension. **MVP**

**4.4** As a developer, I want the extension to pick up my current subscription status automatically (without a manual refresh), so that my access level is always accurate after a plan change. **MVP**

---

### Epic 5 — Language Adapter Architecture

**5.1** As a Covergeist contributor, I want coverage detection and test generation implemented behind a pluggable adapter interface — one adapter per language — so that adding a second language is a contained, self-scoped job that does not require modifying the core engine. **MVP**

**5.2** As a Covergeist contributor, I want the TypeScript/JavaScript adapter to be the sole adapter shipped in v1, so that the team can validate output quality deeply on one language before expanding. **MVP**

---

## 6. Free vs Paid Boundary

### Free (no account, works fully offline)

| Capability | Detail |
|---|---|
| Coverage detection | Runs locally using the project's existing Jest/Vitest coverage tooling |
| Inline haunted indicators | Gutter icons and line decorations for uncovered lines and functions |
| Coverage summary panel | Per-file coverage percentages |
| Cache of last scan result | Persists within the session |

### Paid (account + active subscription required)

| Capability | Detail |
|---|---|
| Test generation | One test per uncovered function/block, per request |
| Jest or Vitest output | Auto-targeted to the detected runner |
| Preview & accept flow | Diff panel before any file is written |
| Monthly generation quota | Capped at [TBD] generations/month on the base tier; cap enforces LLM cost control |

**How the gate works:** When a developer clicks "Generate test" for the first time, the extension checks for a signed-in account. If none exists, it prompts for sign-in/registration. After sign-in, it checks subscription status. If no active subscription exists, it shows an upgrade prompt linking to the web billing page. Generation proceeds only when a valid subscription is confirmed. The generation quota counter is visible in the extension UI for subscribed users.

**Price:** ~€9–15/month (exact price to be validated through competitive research and cost modelling before launch; see §10).

---

## 7. Non-Functional Requirements

**Privacy**
Only the code snippet for the selected function and its immediate surrounding context is transmitted to the backend. The full project codebase never leaves the developer's machine. This must hold as a product guarantee, not merely a preference.

**Performance — detection**
A coverage scan on a project of up to 200 source files must complete within 30 seconds on a typical developer machine. Inline decorations must appear within 2 seconds of scan completion.

**Performance — generation**
A test generation response must be returned and displayed within 15 seconds under normal backend load. If the backend takes longer, the extension must show a visible in-progress indicator (not a silent wait).

**Reliability**
The extension must not crash or destabilise VS Code. All backend errors (timeout, quota exceeded, auth failure) must surface as non-blocking notifications. The extension must degrade gracefully when offline: detection continues to work; generation shows a clear "backend unreachable" message.

**Offline behaviour**
All detection features must work without an internet connection. Generation requires connectivity to the backend and fails clearly if unavailable.

**Distribution**
The extension must meet all VS Code Marketplace publication requirements for packaging, security, and metadata.

---

## 8. Out of Scope (v1)

- Additional language adapters (Python, C#, Go, Rust, or any other language)
- JetBrains IDE support (IntelliJ, WebStorm, etc.)
- Visual Studio (non-Code) support
- Mutation testing
- CI/CD dashboard integration or coverage trend reporting
- Team or organisation-level accounts and analytics
- Pay-per-generation credit system
- In-extension subscription purchase (browser redirect only in v1)
- Batch generation (generating tests for all haunted functions in one action)
- A free-trial allowance for generation (detection is the free value; generation requires a subscription from day one)
- Auto-scan on file save (detection is on-demand in v1)

---

## 9. Resolved Decisions

| # | Question | Decision | Rationale |
|---|---|---|---|
| 1 | Jest or Vitest, or both in MVP? | **Both.** Extension auto-detects the runner from `package.json` and generates tests in the appropriate format. | The syntax difference between Jest and Vitest is narrow (mostly API aliases). Supporting both at generation time is low incremental cost for meaningfully wider reach. Excluding either runner blocks a significant segment of the TypeScript audience. |
| 2 | Subscription only, or also pay-per-generation credits? | **Subscription only.** Monthly generation cap enforces LLM cost control. | Credits require a parallel pricing model, usage ledger, and top-up flow before any usage data exists to inform pricing. A subscription with a cap delivers cost control and a clear upgrade incentive at far lower build cost. Credits can be revisited in v2 once real usage patterns are known. |
| 3 | Account required for detection, or only at generation? | **Account only at generation.** Detection works fully offline with no account. | Detection is local work with no backend dependency. Requiring an account before any value is shown contradicts the product's "editor-local, no upload" promise and creates unnecessary funnel leak. The right moment to ask for an account is when Marcus clicks "Generate test" — he has already seen the gap and wants it closed. |

---

## 10. Assumptions & Dependencies

| # | Item |
|---|---|
| A1 | The developer's project already has Jest or Vitest configured with a coverage provider (e.g. c8 or istanbul). Covergeist does not install or configure coverage tooling — it consumes what is already there. |
| A2 | VS Code's extension API supports the inline decorations, gutter icons, diff/preview panel, and browser-based auth redirect required by the flows above. |
| A3 | Backend LLM costs can be profitably managed within the €9–15/month subscription band. Exact subscription price and monthly generation cap require cost modelling against real token usage before launch. Both are **[TBD]** and must be resolved before the billing epic is implemented. |
| A4 | The brief calls for competitive research to validate pricing and identify feature gaps before locking the PRD. This research is a **pre-launch dependency** and should run in parallel with architecture and early development, but it does not block the Architect or Developer from starting. |
| A5 | The web-based subscription and billing page (§4.3) is a required surface but is out of PRD scope. It constitutes a parallel workstream (its own brief, design, and implementation) that must be ready before the paid tier can launch. |
| A6 | The pluggable adapter interface (Epic 5) is designed so that the TypeScript/JavaScript adapter is the only implementation shipped in v1. The interface must be stable enough that a second adapter can be added without changing the core engine, but it need not anticipate every future language's idioms. |
