# Covergeist

Find untested code and generate ready-to-run tests for it — right inside VS Code.

## How it works

**Detection is free, no account required.**

1. Open a TypeScript or JavaScript project that already has Jest or Vitest configured.
2. Run **Covergeist: Run Coverage Scan** from the command palette or click the sidebar button.
3. Uncovered lines and functions are highlighted inline with gutter icons ("haunted" indicators).
4. A coverage summary panel in the sidebar shows the percentage covered per file.

**Test generation requires a subscription.**

1. Click "Generate test" on any haunted function (via the lightbulb code action or gutter icon).
2. Sign in with your Covergeist account — only asked once, session persists across restarts.
3. Review the generated test in a diff panel before anything is written to disk.
4. Accept to write the test file, or reject to leave your workspace unchanged.

Only the selected function's code snippet is sent to the backend — your full codebase stays on your machine.

## Requirements

- VS Code 1.90 or later
- A TypeScript or JavaScript project with Jest or Vitest already configured and a coverage provider enabled (e.g. `c8` or `istanbul`)

## Extension settings

| Setting | Default | Description |
|---|---|---|
| `covergeist.apiUrl` | `https://api.covergeist.com` | Backend API URL. Override for local development. |
| `covergeist.clerkOAuthClientId` | _(empty)_ | Clerk OAuth Application client ID. |
| `covergeist.clerkFrontendApiUrl` | _(empty)_ | Clerk frontend API URL. |
| `covergeist.billingUrl` | `https://covergeist.com/billing` | URL opened when the user clicks Upgrade. |

## Privacy

Covergeist never uploads your project. Only the code snippet for the function you select is transmitted to the backend for generation. The rest of your codebase remains local.

## Feedback & issues

Report bugs or request features at [github.com/EmperorOlashinbo/Covergeist](https://github.com/EmperorOlashinbo/Covergeist/issues).
