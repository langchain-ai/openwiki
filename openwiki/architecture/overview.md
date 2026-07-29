---
type: Architecture overview
title: OpenWiki Architecture Overview
description: Explains OpenWiki's layered CLI, agent, provider, connector, authentication, and ingestion architecture, including runtime execution and persistence. Identifies core source modules, extension points, and operational considerations for maintaining OpenWiki.
tags: [architecture, cli, agent, providers, connectors, ingestion]
---

# Architecture overview

OpenWiki has a small but layered architecture:

1. `src/cli.tsx` provides the interactive terminal application and orchestrates runs, including auto-exit for init/update.
2. `src/commands.ts` parses argv and defines help text and supported options, including `auth`, `ngrok`, `cron`, and `ingest` subcommands.
3. `src/credentials.tsx` manages interactive onboarding for provider selection, API keys, model selection, and optional LangSmith tracing.
4. `src/env.ts` reads and writes `~/.openwiki/.env` and surfaces credential diagnostics for all supported providers.
5. `src/agent/index.ts` runs the documentation agent, resolves the provider, creates the appropriate model client, collects Git context, and writes update metadata.
6. `src/agent/prompt.ts` builds the system and user prompts that tell the model how to behave.
7. `src/agent/utils.ts` gathers Git evidence, computes an OpenWiki content snapshot, and records `.last-update.json` after successful init/update runs.
8. `src/agent/docs-only-backend.ts` provides `OpenWikiLocalShellBackend`, extending DeepAgents `LocalShellBackend` with docs-only write guards and output-mode awareness.
9. `src/agent/openai-chatgpt-oauth.ts` implements the ChatGPT OAuth login flow, token persistence, and refresh for the `openai-chatgpt` provider.
10. `src/auth/` contains the connector OAuth system: `oauth.ts` (generic runner), `providers.ts` (provider configs), `configure.ts` (`openwiki auth configure`), `ngrok.ts` (Slack HTTPS tunnel), `tokens.ts` (refresh/validation), and `types.ts`.
11. `src/connectors/` contains the connector registry, MCP client/runtime, a shared resilient HTTP helper (`http.ts`), source-specific ingestion modules (git-repo, gmail, hackernews, slack, web-search, x), and tool definitions exposed to the agent.
12. `src/ingestion.ts` orchestrates source ingestion runs across configured connectors.
13. `src/code-mode.ts` handles `openwiki code` setup: creates a GitHub Actions workflow only when it does not already exist (so operator customizations survive `--update` runs), and refreshes AGENTS.md/CLAUDE.md snippets in place.
14. `src/constants.ts` centralizes provider configs, model options, environment keys, validation helpers, and the wiki directory names.
15. `src/agent/types.ts` defines shared types: `OpenWikiCommand`, `RunContext`, `UpdateMetadata`, and run option/event interfaces.

## Runtime shape

The CLI starts in `src/cli.tsx`, parses the command, and then either:

- prints help and exits,
- opens the interactive chat UI,
- runs an init/update command against the current repository, or
- performs a dry-run in development mode.

For non-chat runs, the agent receives a `RunContext` that includes last-update metadata and a Git summary generated from:

- `git status --short`
- `git rev-parse HEAD`
- `git log --max-count=20 --name-status --oneline` (init, or update without prior metadata)
- `git log <lastHead>..HEAD --name-status --oneline` (update with a recorded `gitHead`)
- `git log --since <updatedAt> --name-status --oneline` (update with only a timestamp)
- `git diff --name-status HEAD`

### Provider and model resolution

The agent runtime resolves the provider via `resolveConfiguredProvider()` in `src/constants.ts`:

1. If `OPENWIKI_PROVIDER` is set and valid, use it.
2. Otherwise, use the first available provider API key in this order: OpenAI, OpenAI-compatible, OpenRouter, Anthropic, Baseten, Fireworks, Nebius, NVIDIA, then Bedrock.
3. Otherwise, fall back to `DEFAULT_PROVIDER` (`openai`) and its default model (`gpt-5.6-terra`).

Note: the copilot provider is selectable but never auto-detected — its credential comes from the GitHub CLI at runtime, so `resolveConfiguredProvider()` does not probe for it.

Model creation branches by provider in `src/agent/index.ts` (`createModel`):

- **gemini** → `ChatGoogle` with `platformType: "gai"` (AI Studio), using the Gemini API key. Includes Gemini 3.x thought-signature round-trip options.
- **gemini-enterprise** → `createGeminiEnterpriseModel()`, which routes by model family via `resolveVertexSurface()` in `src/agent/vertex-surface.ts`: Claude models use `ChatAnthropic` with a custom `AnthropicVertex` client (`@anthropic-ai/vertex-sdk`), partner/open-weight models use `ChatOpenAI` against Vertex's OpenAI-compatible MaaS endpoint with a per-request ADC auth fetch, and Gemini/Gemma models use `ChatGoogle` with Google ADC (keyless, `apiKey: ""` to block `GOOGLE_API_KEY` fallback). Auth is Google Application Default Credentials; `GOOGLE_CLOUD_PROJECT` is required and `GOOGLE_CLOUD_LOCATION` is optional (defaults to `global`).
- **anthropic** → `ChatAnthropic` with the Anthropic API key.
- **openai-chatgpt** → `ChatOpenAI` with `useResponsesApi: true`, `zdrEnabled: true`, `streaming: true`, pointed at the Codex backend (`CODEX_RESPONSES_BASE_URL`) with account-id/originator/beta headers. Tokens are refreshed before model creation via `ensureFreshChatGptTokens()`.
- **openrouter** → `ChatOpenRouter` with the selected model ID.
- **bedrock** → `ChatBedrockConverse` (`@langchain/aws`) with AWS access key ID, secret access key, and a required region.
- **openai** → `ChatOpenAI` with `useResponsesApi: true`.
- **copilot** → `ChatOpenAI` with `apiKey` from the GitHub CLI token (or `COPILOT_API_KEY` for CI), `baseURL` from `COPILOT_BASE_URL` or the default Copilot endpoint, and `useResponsesApi` matching `/^gpt-5/u`. Auth is resolved before model creation via `resolveExternalCliCredential()` in `src/external-cli-auth.ts`, which runs `gh auth token` and injects the credential into `process.env` for the current process only.
- **baseten / fireworks / nebius / nvidia / openai-compatible** → `ChatOpenAI` with the provider's API key and optional custom `baseURL` from `PROVIDER_CONFIGS`.

Credential gating before model creation uses `getMissingProviderEnvKey()` in `src/constants.ts`, which requires the provider's API key — or `GOOGLE_CLOUD_PROJECT` for gemini-enterprise — and powers the same check in the CLI's non-interactive gates and the onboarding flow.

### DeepAgents backend and middleware

The agent uses a DeepAgents `LocalShellBackend` rooted at the repository, configured with `virtualMode: true`, `maxOutputBytes: 100_000`, and a 120 second timeout. A SQLite checkpointer (`~/.openwiki/openwiki.sqlite`) persists conversation threads keyed by a hash of the repository path. The agent runtime attaches two middleware layers:

- **OKF index middleware** (`src/agent/okf-middleware.ts`): migrates existing pages to valid OKF front matter before the agent runs, validates front matter on every write, and synchronizes directory `index.md` files after the run. It also validates Mermaid fences via `src/mermaid/wiki.ts` after the agent finishes.
- **Translation middleware** (`src/agent/translation-middleware.ts`): when the output language differs from the wiki's current language, translates all eligible pages before the agent runs. Pages marked `openwiki_translation_pending` from a prior failed run are retranslated individually. The middleware tags its LLM calls with `langsmith:nostream` so translation output does not scroll past in the TUI token stream.

### Content snapshot and metadata writes

After a non-chat run completes, `src/agent/utils.ts` computes a SHA-256 snapshot of the `openwiki/` directory (excluding `.last-update.json`). Metadata is written **only if the snapshot changed** — a no-op update that leaves docs untouched will not update `.last-update.json`. This prevents endless update loops in scheduled workflows.

### Auto-exit behavior

`shouldAutoExitStartupRun()` in `src/cli.tsx` determines whether a startup run should exit automatically on success. This applies to `--init` and `--update` commands (without `--print`) when run in a TTY: the CLI launches the run, renders streaming output, and exits with code 0 on success. Chat runs and `--print` runs are unaffected.

## Why the architecture is shaped this way

The current design reflects a documentation product rather than a general-purpose agent framework:

- The CLI owns user experience and credential bootstrap so the tool is install-and-run friendly.
- Git evidence is collected in the host process before the agent starts so the model sees stable repository context.
- Provider support is centralized in `src/constants.ts` so adding a provider is a single-config change plus a model-creation branch.
- Model execution is provider-stable: transient request failures can retry through the selected LangChain model client, but OpenWiki surfaces the final error instead of continuing with another model.
- The content-snapshot check prevents metadata churn when an update run produces no documentation changes, which is important for scheduled CI workflows.
- Auto-exit for init/update makes the CLI usable in both interactive and one-shot contexts without requiring `--print`.

## Major extension points

- Add or refine CLI commands in `src/commands.ts` and the corresponding UI behavior in `src/cli.tsx`.
- Change onboarding or local credential storage in `src/credentials.tsx` and `src/env.ts`.
- Add a new model provider by extending `PROVIDER_CONFIGS` and `OpenWikiProvider` in `src/constants.ts`, then adding a branch in `createModel` in `src/agent/index.ts`.
- Adjust model defaults, validation, or fallback lists in `src/constants.ts`.
- Extend the documentation prompt or Git evidence in `src/agent/prompt.ts` and `src/agent/utils.ts`.
- Modify run persistence or snapshot behavior in `src/agent/utils.ts`.

## Supporting subsystems

- **OKF compliance** (`src/okf/`): `frontmatter.ts` validates and migrates YAML front matter, `index-labels.ts` localizes directory index headings by BCP-47 language, and `index-sync.ts` deterministically generates and synchronizes every `index.md` after a run. The OKF middleware (`src/agent/okf-middleware.ts`) ties these into the agent lifecycle.
- **Mermaid validation** (`src/mermaid/`): `fences.ts` extracts Mermaid code fences from wiki pages, `validate.ts` parses and validates them, and `wiki.ts` repairs broken fences by converting them to plain text fences with an HTML comment explaining the parse error. The OKF middleware calls `validateWikiMermaid()` after every run.
- **Telemetry** (`src/telemetry/`): emits a single `openwiki_run` PostHog event per run with mode, provider, outcome, latency, and configured connectors. `gates.ts` checks `OPENWIKI_TELEMETRY_DISABLED` / `DO_NOT_TRACK` for opt-out and uses `ci-info` to tag CI runs with a sentinel distinct ID so ephemeral runners never inflate install counts. `record-run-safe.ts` wraps the send with a 3-second flush timeout so telemetry can never stall the CLI.
- **Skills** (`src/agent/skills.ts`): bundles the `skills/` directory into the OpenWiki home and exposes it to the agent as a `/skills/` filesystem backend with write access denied. Each bundled skill is staged in a unique scratch directory and swapped into place with an atomic `rename`, so repeated or overlapping `--init` syncs are idempotent — a concurrent install that lands first is accepted as success rather than racing with `EEXIST` or `ENOTEMPTY` errors.
- **Diagnostics and redaction** (`src/diagnostics.ts`): redacts secrets from error messages, headers, and provider responses before they are shown to the user or written to logs. It matches exact secret values from the environment and known token shapes (`sk-…`, `Bearer …`, `ls…`).

## Things to watch when editing

- `src/cli.tsx` and `src/commands.ts` must stay aligned; help text and parser behavior are intentionally coupled.
- Credential setup writes to a real home-directory file, so permission handling matters.
- The agent is expected to work from repository-local virtual paths like `/README.md` and `/openwiki/quickstart.md`; the prompt explicitly warns about this.
- `openwiki/` in the target repository is both the docs output location and the metadata location for `.last-update.json`.
- When adding a provider, update `managedEnvKeys` in `src/env.ts` so diagnostics and env formatting cover the new key.
- The content-snapshot logic excludes `.last-update.json`; if new metadata files are added under `openwiki/`, decide whether they should be excluded too.

## Source map

- `src/cli.tsx`
- `src/commands.ts`
- `src/credentials.tsx`
- `src/env.ts`
- `src/agent/index.ts`
- `src/agent/prompt.ts`
- `src/agent/utils.ts`
- `src/agent/types.ts`
- `src/agent/docs-only-backend.ts`
- `src/agent/openai-chatgpt-oauth.ts`
- `src/agent/okf-middleware.ts`
- `src/agent/translation-middleware.ts`
- `src/agent/vertex-surface.ts`
- `src/agent/skills.ts`
- `src/external-cli-auth.ts`
- `src/diagnostics.ts`
- `src/okf/frontmatter.ts`, `src/okf/index-labels.ts`, `src/okf/index-sync.ts`
- `src/mermaid/fences.ts`, `src/mermaid/validate.ts`, `src/mermaid/wiki.ts`, `src/mermaid/dom-shim.ts`
- `src/telemetry/`
- `src/auth/oauth.ts`
- `src/auth/providers.ts`
- `src/auth/configure.ts`
- `src/auth/ngrok.ts`
- `src/auth/tokens.ts`
- `src/auth/types.ts`
- `src/connectors/registry.ts`
- `src/connectors/tools.ts`
- `src/connectors/types.ts`
- `src/connectors/http.ts`
- `src/ingestion.ts`
- `src/code-mode.ts`
- `src/constants.ts`
- `package.json`
