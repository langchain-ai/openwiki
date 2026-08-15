---
type: Architecture overview
title: OpenWiki Architecture Overview
description: Explains OpenWiki's layered CLI, agent, provider, connector, authentication, and ingestion architecture, including runtime execution and persistence. Identifies core source modules, extension points, and operational considerations for maintaining OpenWiki.
tags: [architecture, cli, agent, providers, connectors, ingestion]
---

# Architecture overview

OpenWiki has a small but layered architecture:

1. `src/cli/cli.tsx` is the process entrypoint: it loads env, parses argv, and dispatches to the Ink interactive app (`src/cli/app/app.tsx`) or the appropriate runner. The interactive app orchestrates runs, including auto-exit for init/update.
2. `src/cli/commands.ts` parses argv and defines help text and supported options, including `auth`, `ngrok`, `cron`, and `ingest` subcommands.
3. `src/setup/credentials.tsx` (thin re-export over `src/setup/credentials/` modules) manages interactive onboarding for provider selection, API keys, model selection, and optional LangSmith tracing.
4. `src/config/env.ts` reads and writes `~/.openwiki/.env` and surfaces credential diagnostics for all supported providers.
5. `src/agent/index.ts` runs the documentation agent, resolves the provider, creates the appropriate model client, collects Git context, and writes update metadata.
6. `src/agent/prompt.ts` builds the system and user prompts that tell the model how to behave.
7. `src/agent/utils.ts` gathers Git evidence, computes an OpenWiki content snapshot, and records `.last-update.json` after successful init/update runs.
8. `src/agent/docs-only-backend.ts` provides `OpenWikiLocalShellBackend`, extending DeepAgents `LocalShellBackend` with docs-only write guards, output-mode awareness, and `glob` guards that reject unbounded root globs (`**`, `**/*`, `**/**` at the repository root) and globs targeting `.git` metadata, and that recover the worktree `ENOTDIR` scandir error raised when a glob scans a file-backed `.git` pointer as a directory.
9. `src/agent/openai-chatgpt-oauth.ts` implements the ChatGPT OAuth login flow, token persistence, and refresh for the `openai-chatgpt` provider.
10. `src/auth/` contains the connector OAuth system: `oauth.ts` (generic runner), `providers.ts` (provider configs), `configure.ts` (`openwiki auth configure`), `ngrok.ts` (Slack HTTPS tunnel), `tokens.ts` (refresh/validation), `oauth-discovery.ts` (OAuth endpoint validation and protected-resource metadata discovery), and `types.ts`.
11. `src/connectors/` contains the connector registry, MCP client/runtime, a shared resilient HTTP helper (`http.ts`), source-specific ingestion modules (git-repo, gmail, hackernews, slack, web-search, x), the generic `custom-mcp` MCP source, and tool definitions exposed to the agent.
12. `src/ingestion/ingestion.ts` orchestrates source ingestion runs across configured connectors.
13. `src/ingestion/code-mode.ts` handles `openwiki code` setup: creates a GitHub Actions workflow only when it does not already exist (so operator customizations survive `--update` runs), and refreshes AGENTS.md/CLAUDE.md snippets in place.
14. `src/config/constants.ts` centralizes provider configs, model options, environment keys, validation helpers, and the wiki directory names.
15. `src/agent/types.ts` defines shared types: `OpenWikiCommand`, `RunContext`, `UpdateMetadata`, and run option/event interfaces.

## Runtime shape

The CLI starts in `src/cli/cli.tsx`, parses the command, and then either:

- prints help and exits,
- opens the interactive chat UI,
- runs an init/update command against the current repository, or
- performs a dry-run in development mode.

For non-chat runs, the agent receives a `RunContext` carrying `lastUpdate`, `language`, and `wikiGoal`. The prompt templates instruct the agent to gather its own Git evidence during the run by running:

- `git rev-parse HEAD`
- `git log <lastHead>..HEAD --name-status --oneline` (update with a recorded `gitHead`)
- `git log --max-count=20 --name-status --oneline` (init, or update without prior metadata)
- `git log --since <updatedAt> --name-status --oneline` (update with only a timestamp)
- `git status` / `git diff` to account for uncommitted local changes

`createRunContext()` no longer precomputes a git summary; `.openwikiignore` exclusions are enforced by the filesystem backend and the restricted shell-execute allowlist instead of by pre-filtering a summary.

### Model availability pre-check

After the provider and model ID are resolved, `resolveRunConfig()` in `src/agent/index.ts` calls `getSelectedModelAvailability()` in `src/model-availability.ts` before model creation. For the `openai` provider with an API key and the default OpenAI endpoint, it queries `GET https://api.openai.com/v1/models` and aborts the run with a clear message when the selected model is not exposed to the configured credentials (`status: "unavailable"`). Every other case resolves to `status: "unknown"` — non-OpenAI providers (no availability adapter), custom OpenAI-compatible endpoints (no Models API semantics assumed), a missing API key, a non-OK response, or a network failure — and proceeds to inference, so a catalogue lookup failure never blocks a run that could otherwise succeed. An `unknown` result is logged to the debug stream with its reason.

### Provider and model resolution

The agent runtime resolves the provider via `resolveConfiguredProvider()` in `src/config/constants.ts`:

1. If `OPENWIKI_PROVIDER` is set and valid, use it.
2. Otherwise, use the first available provider API key in this order: OpenAI, OpenAI-compatible, OpenRouter, Anthropic, Baseten, Fireworks, Nebius, NVIDIA, then Bedrock.
3. Otherwise, fall back to `DEFAULT_PROVIDER` (`openai`) and its default model (`gpt-5.6-terra`).

Note: the copilot provider is selectable but never auto-detected — its credential comes from the GitHub CLI at runtime, so `resolveConfiguredProvider()` does not probe for it.

Model creation branches by provider in `src/agent/index.ts` (`createModel`):

- **gemini** → `ChatGoogle` with `platformType: "gai"` (AI Studio), using the Gemini API key. Includes Gemini 3.x thought-signature round-trip options.
- **gemini-enterprise** → `createGeminiEnterpriseModel()`, which routes by model family via `resolveVertexSurface()` in `src/agent/vertex-surface.ts`: Claude models use `ChatAnthropic` with a custom `AnthropicVertex` client (`@anthropic-ai/vertex-sdk`), partner/open-weight models use `ChatOpenAI` against Vertex's OpenAI-compatible MaaS endpoint with a per-request ADC auth fetch, and Gemini/Gemma models use `ChatGoogle` with Google ADC (keyless, `apiKey: ""` to block `GOOGLE_API_KEY` fallback). Auth is Google Application Default Credentials; `GOOGLE_CLOUD_PROJECT` is required and `GOOGLE_CLOUD_LOCATION` is optional (defaults to `global`).
- **anthropic** → `ChatAnthropic` with the Anthropic API key.
- **openai-chatgpt** → `ChatOpenAI` with `useResponsesApi: true`, `zdrEnabled: true`, `streaming: true`, pointed at the Codex backend (`CODEX_RESPONSES_BASE_URL`) with account-id/originator/beta headers. Tokens are refreshed before model creation via `ensureFreshChatGptTokens()`.
- **openrouter** → `ChatOpenRouter` with the selected model ID. When `OPENWIKI_OPENROUTER_MAX_TOKENS` is set to a positive integer (resolved by `resolveOpenRouterMaxTokens()` in `src/config/constants.ts`), the cap is passed as `maxTokens` so OpenRouter's credit pre-check budgets against the cap rather than the model's full advertised output ceiling (which otherwise triggers 402 errors on low balances).
- **bedrock** → `ChatBedrockConverse` (`@langchain/aws`) with AWS access key ID, secret access key, and a required region.
- **openai** → `ChatOpenAI` with `useResponsesApi: true`.
- **copilot** → `ChatOpenAI` with `apiKey` from the GitHub CLI token (or `COPILOT_API_KEY` for CI), `baseURL` from `COPILOT_BASE_URL` or the default Copilot endpoint, and `useResponsesApi` matching `/^gpt-5/u`. Auth is resolved before model creation via `resolveExternalCliCredential()` in `src/auth/external-cli-auth.ts`, which runs `gh auth token` and injects the credential into `process.env` for the current process only.
- **baseten / fireworks / nebius / nvidia / openai-compatible** → `ChatOpenAI` with the provider's API key and optional custom `baseURL` from `PROVIDER_CONFIGS`; `useResponsesApi` is resolved by `providerUsesResponsesApi()`, which for `openai-compatible` honors the `OPENWIKI_OPENAI_COMPATIBLE_USE_RESPONSES_API` opt-in (default chat completions) and is `false` for the others.

Credential gating before model creation uses `getMissingProviderEnvKey()` in `src/config/constants.ts`, which requires the provider's API key — or `GOOGLE_CLOUD_PROJECT` for gemini-enterprise — and powers the same check in the CLI's non-interactive gates and the onboarding flow.

### DeepAgents backend and middleware

The agent uses a DeepAgents `LocalShellBackend` rooted at the repository, configured with `virtualMode: true`, `maxOutputBytes: 100_000`, and a 120 second timeout. A SQLite checkpointer (`~/.openwiki/openwiki.sqlite`) persists conversation threads keyed by a hash of the repository path.

`createAgentBackend()` in `src/agent/index.ts` wraps that wiki backend in an `OpenWikiCompositeBackend` (a DeepAgents `CompositeBackend` subclass) that layers two read-only virtual mounts on top of the documented repository:

- `/skills/` — the bundled and user skills under `~/.openwiki/skills` (populated by `src/agent/skills.ts`).
- `/conversation_history/` — the DeepAgents summarization middleware's history offload, routed to `~/.openwiki/conversation_history` (created by `ensureOpenWikiHome()` in `src/config/openwiki-home.ts`). `createDeepAgent` exposes no way to override the `/conversation_history` default prefix, so the mount prefix is kept in sync with it via the exported `CONVERSATION_HISTORY_MOUNT` constant. Routing the offload outside the repository is what lets it succeed on docs-only `--init`/`--update` runs: without the mount, the docs-only write guard refuses the offload write, that refusal is non-fatal, and summarization silently degrades — narrowing coverage on large repositories while the run still exits 0 (#496).

Both mounts are denied to the model's own filesystem tools via `AGENT_FILESYSTEM_PERMISSIONS` (`/skills/**` and `/conversation_history/**`, `mode: "deny"` for writes). The summarization middleware writes directly through the backend, which agent-layer permissions do not affect, so the offload keeps working while prompt-injected `write_file` calls into either mount are refused.

The agent runtime attaches two middleware layers:

- **OKF index middleware** (`src/agent/okf-middleware.ts`): migrates existing pages to valid OKF front matter before the agent runs, validates front matter on every write, and synchronizes directory `index.md` files after the run. Its `afterAgent` finalize stage runs three validation passes: Mermaid fences via `src/mermaid/wiki.ts`, index synchronization, and internal link validation via `src/agent/wiki-link-validator.ts`. The link validator resolves targets against the whole repository (not just the `openwiki/` subtree), since wiki pages may legitimately link out to repo files that render on GitHub; a link is broken only when its target genuinely does not exist. Heading anchors are validated only against Markdown targets, so directory links and GitHub line anchors on source files (e.g. `#L10`) are never flagged. `slugifyHeading` mirrors `github-slugger` (keeps combining marks, replaces whitespace per-character without collapsing) so anchors like `a--b` from stripped punctuation resolve. Broken links are stamped inline with `openwiki:` HTML comments instead of failing the run — the same degrade-and-self-repair pattern Mermaid uses — so a later update can repair the href from the inline comment.
- **Translation middleware** (`src/agent/translation-middleware.ts`): when the output language differs from the wiki's current language, translates all eligible pages before the agent runs. Pages marked `openwiki_translation_pending` from a prior failed run are retranslated individually. The middleware tags its LLM calls with `langsmith:nostream` so translation output does not scroll past in the TUI token stream.

### Content snapshot and metadata writes

After a non-chat run completes, `src/agent/utils.ts` computes a SHA-256 snapshot of the `openwiki/` directory (excluding `.last-update.json`). Metadata is written **only if the snapshot changed** — a no-op update that leaves docs untouched will not update `.last-update.json`. This prevents endless update loops in scheduled workflows.

### Auto-exit behavior

`shouldAutoExitStartupRun()` in `src/cli/cli.tsx` determines whether a startup run should exit automatically on success. This applies to `--init` and `--update` commands (without `--print`) when run in a TTY: the CLI launches the run, renders streaming output, and exits with code 0 on success. Chat runs and `--print` runs are unaffected.

### Streaming and crash guard

The live run consumes the agent via `agent.stream({ streamMode: ["messages", "tools"], subgraphs: true })` rather than the Agent Protocol `streamEvents` API. `parseAgentStreamChunk()` in `src/agent/index.ts` normalizes each `[namespace, mode, payload]` chunk into an `OpenWikiRunEvent`: `tools` chunks become tool start/end events (tool-call strings pass through `sanitizeDiagnosticText()` so secrets are redacted), and `messages` chunks yield text after `extractMessageText()` filters non-text content blocks (`tool`, `reasoning`, `file`, `image`) so base64 payloads never reach the terminal. A namespace longer than one element marks the event `source: "subgraph"`, which is how init subagent output is attributed. `parseStreamEvent()` remains exported for the public agent factory's Agent Protocol v3 event shape, but the live run no longer uses it.

A process-wide crash guard (`src/agent/crash-guard.ts`) is installed once at CLI startup via `installCrashGuard()`. The run registers itself with `registerActiveRun()` for the stream-consumption window only and clears it in `finally`; if a rejection escapes every catch (e.g. a subagent error on the microtask queue), `handleFatal()` records the failure to telemetry, stamps the run `interrupted`, and exits non-zero. `handleFatal()` claims the active run synchronously — `getActiveRun()` followed immediately by `clearActiveRun()` with no `await` between them, before any async side effect — so a burst of escaped rejections landing together on the microtask queue produces one crash event: the first handler wins the run and every later handler sees `undefined` and only exits. Do not move an `await` above that pair; doing so reintroduces the race where one crash records hundreds of duplicate events. See [Agent workflow § Crash guard](../agent/workflow.md#crash-guard) for the post-mortem contract.

## Why the architecture is shaped this way

The current design reflects a documentation product rather than a general-purpose agent framework:

- The CLI owns user experience and credential bootstrap so the tool is install-and-run friendly.
- Git evidence is gathered by the agent itself during the run (per the prompt templates), so the model can adapt its discovery to the actual change window rather than consuming a fixed precomputed summary.
- Provider support is centralized in `src/config/constants.ts` so adding a provider is a single-config change plus a model-creation branch.
- Model execution is provider-stable: transient request failures can retry through the selected LangChain model client, but OpenWiki surfaces the final error instead of continuing with another model.
- The content-snapshot check prevents metadata churn when an update run produces no documentation changes, which is important for scheduled CI workflows.
- Auto-exit for init/update makes the CLI usable in both interactive and one-shot contexts without requiring `--print`.

## Major extension points

- Add or refine CLI commands in `src/cli/commands.ts` and the corresponding UI behavior in `src/cli/app/app.tsx` and `src/cli/cli.tsx`.
- Change onboarding or local credential storage in `src/setup/credentials.tsx` (with `src/setup/credentials/` modules) and `src/config/env.ts`.
- Add a new model provider by extending `PROVIDER_CONFIGS` and `OpenWikiProvider` in `src/config/constants.ts`, then adding a branch in `createModel` in `src/agent/index.ts`.
- Adjust model defaults, validation, or fallback lists in `src/config/constants.ts`.
- Extend the documentation prompt or Git evidence in `src/agent/prompts/code.ts`, `src/agent/prompts/personal.ts`, and `src/agent/prompt.ts` (assembler); run persistence and snapshot behavior live in `src/agent/utils.ts`.

## Supporting subsystems

- **OKF compliance** (`src/okf/`): `frontmatter.ts` validates and migrates YAML front matter, `index-labels.ts` localizes directory index headings by BCP-47 language, and `index-sync.ts` deterministically generates and synchronizes every `index.md` after a run. The OKF middleware (`src/agent/okf-middleware.ts`) ties these into the agent lifecycle.
- **Mermaid validation** (`src/mermaid/`): `fences.ts` extracts Mermaid code fences from wiki pages, `validate.ts` parses and validates them, and `wiki.ts` repairs broken fences by converting them to plain text fences with an HTML comment explaining the parse error. The OKF middleware calls `validateWikiMermaid()` after every run.
- **Telemetry** (`src/telemetry/`): emits a single `openwiki_run` PostHog event per run with mode, provider, outcome, latency, configured connectors, and a build channel. `gates.ts` checks `OPENWIKI_TELEMETRY_DISABLED` / `DO_NOT_TRACK` for opt-out, uses `ci-info` to tag CI runs with a sentinel distinct ID so ephemeral runners never inflate install counts, and bakes a `BUILD_CHANNEL` (`"community"` in committed source, stamped to `"official"` only on the upstream release path — see [Credentials and updates § Build channel stamping](../operations/credentials-and-updates.md#build-channel-stamping)) so every event carries it and the dashboard can filter fork-originated telemetry. `record-run-safe.ts` wraps the send with a 3-second flush timeout so telemetry can never stall the CLI. `errors.ts` classifies failures by walking an unwrap chain (`unwrapErrorChain()`, bounded at 32 links, cycle-safe) so a provider error buried under several framework envelopes is recovered instead of collapsing into the residual `agent_error` bucket, with one origin-tag override (`streamOpenDisguisesProvider()`) that reclassifies a `build_error/stream_open` tag masking a provider failure. The residual `agent_error` bucket's one signal is the innermost error's own allowlisted name, folded into `error_detail` via `innermostErrorName()`; see [Credentials and updates § Error classification and fingerprinting](../operations/credentials-and-updates.md#error-classification-and-fingerprinting) for the full taxonomy, identifier allowlist, and override rules. `client.ts` `capture()` returns `true` only when the PostHog send fulfills before the flush timeout, so send failures and timeouts are reported as failures rather than silently swallowed.
- **Skills** (`src/agent/skills.ts`): bundles the `skills/` directory into the OpenWiki home and exposes it to the agent as the `/skills/` virtual mount on the `CompositeBackend` built by `createAgentBackend()` (see [DeepAgents backend and middleware](#deepagents-backend-and-middleware)). Write access to `/skills/**` is denied to the model via `AGENT_FILESYSTEM_PERMISSIONS`. Each bundled skill is staged in a unique scratch directory and swapped into place with an atomic `rename`, so repeated or overlapping `--init` syncs are idempotent — a concurrent install that lands first is accepted as success rather than racing with `EEXIST` or `ENOTEMPTY` errors. Before the swap, `grantOwnerWrite()` recursively adds the owner-write bit across the staged tree (skipping symlinks), so a bundled skill shipped read-only (the Nix store and immutable container images mount `skills/` as `dr-xr-xr-x`) yields a writable, self-healing installed copy whose `rename` and `finally` cleanup both succeed.
- **Diagnostics and redaction** (`src/platform/diagnostics.ts`): redacts secrets from error messages, headers, and provider responses before they are shown to the user or written to logs. It matches exact secret values from the environment and known token shapes (`sk-…`, `Bearer …`, `ls…`).
- **Untrusted-text sanitization** (`src/platform/utils.ts`): `stripHtmlTags()` removes angle brackets from markdown token text, and `stripTerminalControlSequences()` strips ANSI/VT escape, CSI, OSC, DCS, SOS, PM, and APC sequences plus non-whitespace C0/C1 controls from streamed model output before the Ink markdown renderer lexes it. Newlines and tabs are preserved as useful Markdown whitespace; other C0/C1 controls are discarded rather than passed to a terminal emulator. `MarkdownText` in `src/cli/components/markdown.tsx` applies `stripTerminalControlSequences()` before `marked.lexer`, so a prompt-injected escape sequence in model output can no longer reformat the terminal (#550).

## Things to watch when editing

- `src/cli/cli.tsx` and `src/cli/commands.ts` must stay aligned; help text and parser behavior are intentionally coupled.
- Credential setup writes to a real home-directory file, so permission handling matters.
- The agent is expected to work from repository-local virtual paths like `/README.md` and `/openwiki/quickstart.md`; the prompt explicitly warns about this.
- `openwiki/` in the target repository is both the docs output location and the metadata location for `.last-update.json`.
- When adding a provider, update `managedEnvKeys` in `src/config/env.ts` so diagnostics and env formatting cover the new key.
- The content-snapshot logic excludes `.last-update.json`; if new metadata files are added under `openwiki/`, decide whether they should be excluded too.

## Source map

- `src/cli/cli.tsx`
- `src/cli/app/app.tsx`
- `src/cli/commands.ts`
- `src/cli/runners.ts`
- `src/setup/credentials.tsx` (re-exports `src/setup/credentials/`)
- `src/config/env.ts`
- `src/agent/index.ts`
- `src/model-availability.ts`
- `src/agent/prompt.ts`
- `src/agent/prompts/code.ts`
- `src/agent/prompts/personal.ts`
- `src/agent/skeleton_critic.ts`
- `src/agent/wiki_qa_subagents.ts`
- `src/agent/crash-guard.ts`
- `src/agent/utils.ts`
- `src/agent/types.ts`
- `src/agent/docs-only-backend.ts`
- `src/agent/openai-chatgpt-oauth.ts`
- `src/agent/okf-middleware.ts`
- `src/agent/translation-middleware.ts`
- `src/agent/vertex-surface.ts`
- `src/agent/skills.ts`
- `src/auth/external-cli-auth.ts`
- `src/platform/diagnostics.ts`
- `src/platform/utils.ts`
- `src/okf/frontmatter.ts`, `src/okf/index-labels.ts`, `src/okf/index-sync.ts`
- `src/mermaid/fences.ts`, `src/mermaid/validate.ts`, `src/mermaid/wiki.ts`, `src/mermaid/dom-shim.ts`
- `src/telemetry/` (including `errors.ts`, `gates.ts`, `record-run-safe.ts`, `senders.ts`, `client.ts`)
- `src/auth/oauth.ts`
- `src/auth/oauth-discovery.ts`
- `src/auth/providers.ts`
- `src/auth/configure.ts`
- `src/auth/ngrok.ts`
- `src/auth/tokens.ts`
- `src/auth/types.ts`
- `src/connectors/registry.ts`
- `src/connectors/tools.ts`
- `src/connectors/types.ts`
- `src/connectors/http.ts`
- `src/ingestion/ingestion.ts`
- `src/ingestion/code-mode.ts`
- `src/config/constants.ts`
- `package.json`
- `scripts/stamp-build-channel.cjs`
- `.github/workflows/release.yml`
