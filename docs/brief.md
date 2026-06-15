# Covergeist — Project Brief

> BMAD artifact: `docs/brief.md` — produced by the Analyst agent.
> Status: draft v2. Updated after scope decisions. Feeds the PM agent, who turns it into the PRD.

## One-line pitch

Covergeist finds the untested "haunted" code in your TypeScript project and offers to write the missing tests for you — right inside your editor.

## The problem

Writing tests is the part of development everyone agrees is important and almost everyone neglects. For TypeScript/JavaScript teams specifically:

- Coverage tools (Istanbul/nyc, Vitest's built-in coverage) tell you *what* isn't covered, but stop there. The developer still writes every test by hand.
- AI assistants can write tests, but they work blind — they don't know which parts of the codebase are actually exposed, so they generate tests for already-covered code and miss the risky gaps.

The gap between "here is your coverage report" and "here are the tests that close it" is still manual labour. That gap is the product.

## Target user

**Primary:** Solo developers and small TypeScript/JavaScript teams (2–10 engineers) who care about quality but have no dedicated QA function. They ship under time pressure and let coverage slip.

**Secondary:** Developers preparing code for review, interviews, or open-source release who want to raise coverage quickly.

Persona — "Marcus, the pragmatic Node dev": works on a TS API, knows his coverage is ~40%, feels guilty about it, but writing tests for legacy modules is tedious enough that he never starts. He'd pay a small monthly fee for something that does the boring 80%.

## The core job (in order)

1. **Detect** — scan the open TypeScript project, run coverage analysis, and surface uncovered lines and functions inline in the editor ("haunted" code). *Free.*
2. **Generate** — for any flagged gap, generate a ready-to-run Jest or Vitest test via the cloud backend, which the developer reviews and accepts. *Paid.*

Detection earns trust and installs; generation earns money.

## Value proposition

- Turns a passive coverage report into a one-click fix.
- Lives in the editor — no uploading proprietary code to a website.
- Free tier is genuinely useful on its own, which drives adoption and word of mouth.

## Form factor & architecture (high level)

- **Client:** VS Code extension (TypeScript). Handles UI, coverage parsing, inline highlighting. Distributed via the VS Code Marketplace.
- **Backend:** a small Node/TypeScript cloud service (the paid component) that receives a code snippet + context and returns a generated test. Subscription-gated, usage-metered.
- **Single language across the whole stack** — extension and backend are both TypeScript. One mental model, shared types, one toolchain.

### Language support: extensible underneath, focused on top

This is a deliberate design principle, not a limitation.

- The core is built around **pluggable language adapters**. Each adapter implements a small interface: *parse this language's coverage format* and *generate tests in this language's idioms*.
- The engine itself is language-agnostic.
- **v1 ships exactly one adapter: TypeScript/JavaScript.** Adding Python, C#, Go, etc. later is a contained, self-sized job per language — not a rewrite.

Why this and not "all languages at launch": coverage detection and test generation are both language-specific (every ecosystem has its own coverage format and test conventions). Shipping ten languages means shipping ten mediocre integrations. One excellent language beats ten weak ones on trust, marketing, and the founder's ability to validate output quality. The adapter design preserves the "works with everything eventually" vision without sinking the MVP.

## Business model

Freemium. Detection is free forever. Test generation is metered behind a subscription (target price ~€9–15/month, validated later). The free tier is the marketing channel; the Marketplace is the distribution channel.

## Competitive landscape

The AI-test-generation space is **active** — several tools already generate tests or analyse coverage. That's a signal that demand is real, not that the space is closed.

Covergeist's wedge: most competitors do *either* coverage analysis *or* AI generation. Covergeist ties them together — generation is driven by detected gaps, so it never wastes effort testing already-covered code — and it stays editor-local rather than web-based.

*The PM agent should commission deeper competitive research to confirm pricing and feature gaps before locking the PRD.*

## Scope

**In (MVP):**
- TypeScript/JavaScript only (via the first language adapter).
- Coverage detection + inline highlighting in VS Code.
- AI test generation for a single function/module (Jest and Vitest output).
- Pluggable adapter architecture in place (even with one adapter shipped).
- Basic auth + subscription for the paid tier.

**Out (later):**
- Additional language adapters (Python, C#, Go, …).
- Full-IDE Visual Studio / JetBrains support.
- Mutation testing, CI dashboards, team analytics.

## Success metrics (first 3 months post-launch)

- 500+ Marketplace installs.
- 5%+ free-to-paid conversion.
- First €100 in recurring revenue (the real milestone — proof someone will pay).

## Key risks

- **LLM cost per generation could exceed price.** Mitigation: meter usage tightly, cache, price the subscription against real token costs.
- **Crowded category.** Mitigation: the detect-then-generate wedge and a sharp TypeScript-first position differentiate against generic "AI test" tools.
- **Adapter abstraction over-engineered too early.** Mitigation: keep the interface minimal; build it to make adapter #2 cheap, not to anticipate every future language.

## Open questions for the PM phase

1. Jest and Vitest both in MVP, or pick one to start?
2. Subscription only, or also a pay-per-generation credit option?
3. Does the free tier need an account, or work fully offline until the user wants generation?
