---
type: Architecture overview
title: OpenWiki Architecture Overview
description: Explains OpenWiki's layered CLI, agent, provider, connector, authentication, and ingestion architecture, including runtime execution and persistence. Identifies core source modules, extension points, and operational considerations for maintaining OpenWiki.
tags: [architecture, cli, agent, providers, connectors, ingestion]
generated: { by: "openwiki/0.3.3", at: "2026-08-21T08:12:50.745Z" }
sources:
  - id: openwiki-source-6fd9c8ed42336141de43b3c2
    resource: repo://src/agent/okf-middleware.ts
  - id: openwiki-source-adcadc660c1888613ec50f9a
    resource: repo://src/agent/wiki-finalizer.ts
  - id: openwiki-source-239b2968fb2bcd073e89cedc
    resource: repo://src/claims/brains/code/runtime.ts
  - id: openwiki-source-58835b77ce38a0dd1fed8d09
    resource: repo://src/integrations/core/session-manager.ts
  - id: openwiki-source-2557815e72f267f9941d446a
    resource: repo://src/integrations/install/installer.ts
  - id: openwiki-source-6f06cc988142430d18f2233e
    resource: repo://src/integrations/mcp/stdio.ts
verified:
  - by: openwiki/0.3.3
    at: 2026-08-21T08:12:50.745Z
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
16. `src/claims/` is the [Grounded Claims](../claims/grounded-claims.md) subsystem: it maintains page-owned factual propositions as JSON sidecars under `openwiki/.claims/`, resolves repository evidence (`repo://path#Lx-Ly`), and projects evidence and verification into OKF `sources`/`verified` front matter. `prepareClaimsRuntime()` prepares the runtime for repository init/update runs only, wiring `resolve_claims`, `inspect_claims`, and a Claims-aware `delete_file` tool plus a read-note middleware into the agent graph.
17. `src/integrations/` is the [coding-agent integrations](../integrations/coding-agents.md) subsystem: a transactional installer deploys the OpenWiki skill bundle and MCP config into Codex and Claude Code, and a stdio MCP server (`openwiki mcp --host <id>`) exposes a begin/inspect_claims/resolve_claims/finish lifecycle protocol that reuses the same Claims runtime and wiki finalizer as the native agent.
18. `src/agent/wiki-finalizer.ts` extracts the deterministic wiki lifecycle (`prepareWikiForAuthoring`/`finalizeWikiArtifacts`) shared by the OKF middleware and the MCP host session manager: migration, provenance snapshot, Mermaid validation, index sync, link validation, claims-sources projection, and generated-provenance reconciliation.

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

`resolveRunConfig()` also resolves the per-run model knobs before `createModel()` is called: `OPENWIKI_PROVIDER_RETRY_ATTEMPTS` (retry count, default 3), `OPENWIKI_MAX_OUTPUT_TOKENS` (a positive-integer override for the model client's output token limit, applied as `maxTokens` to non-Google clients and `maxOutputTokens` to `ChatGoogle`/Vertex Gemini surfaces), the Bedrock-only `OPENWIKI_STREAM_IDLE_TIMEOUT` (milliseconds, `0` disables the LangChain watchdog; `resolveStreamIdleTimeoutForProvider()` ignores a stale value when the active provider is not `bedrock`), and `OPENWIKI_REASONING_EFFORT` for supported reasoning-capable models (see [Reasoning effort](#reasoning-effort)). Each is logged to the debug stream with its resolved value or `provider-default`.

Model creation branches by provider in `src/agent/index.ts` (`createModel`):

- **gemini** → `ChatGoogle` with `platformType: "gai"` (AI Studio), using the Gemini API key. Includes Gemini 3.x thought-signature round-trip options.
- **gemini-enterprise** → `createGeminiEnterpriseModel()`, which routes by model family via `resolveVertexSurface()` in `src/agent/vertex-surface.ts`: Claude models use `ChatAnthropic` with a custom `AnthropicVertex` client (`@anthropic-ai/vertex-sdk`), partner/open-weight models use `ChatOpenAI` against Vertex's OpenAI-compatible MaaS endpoint with a per-request ADC auth fetch, and Gemini/Gemma models use `ChatGoogle` with Google ADC (keyless, `apiKey: ""` to block `GOOGLE_API_KEY` fallback). Auth is Google Application Default Credentials; `GOOGLE_CLOUD_PROJECT` is required and `GOOGLE_CLOUD_LOCATION` is optional (defaults to `global`).
- **anthropic** → `ChatAnthropic` with the Anthropic API key.
- **openai-chatgpt** → `ChatOpenAI` with `useResponsesApi: true`, `zdrEnabled: true`, `streaming: true`, pointed at the Codex backend (`CODEX_RESPONSES_BASE_URL`) with account-id/originator/beta headers. Tokens are refreshed before model creation via `ensureFreshChatGptTokens()`.
- **openrouter** → `ChatOpenRouter` with the selected model ID. When `OPENWIKI_OPENROUTER_MAX_TOKENS` is set to a positive integer (resolved by `resolveOpenRouterMaxTokens()` in `src/config/constants.ts`), the cap is passed as `maxTokens` so OpenRouter's credit pre-check budgets against the cap rather than the model's full advertised output ceiling (which otherwise triggers 402 errors on low balances).
- **bedrock** → `ChatBedrockConverse` (`@langchain/aws`) with AWS access key ID, secret access key, and a required region. When `OPENWIKI_MAX_OUTPUT_TOKENS` is set, it is passed as `maxTokens`; when `OPENWIKI_STREAM_IDLE_TIMEOUT` is set (Bedrock only), it is passed as `streamIdleTimeout` so the client waits that long for the first or next streamed chunk (the `@langchain/aws` default is preserved when unset).
- **openai** → `ChatOpenAI` with `useResponsesApi: true`.
- **copilot** → `ChatOpenAI` with `apiKey` from the GitHub CLI token (or `COPILOT_API_KEY` for CI), `baseURL` from `COPILOT_BASE_URL` or the default Copilot endpoint, and `useResponsesApi` matching `/^gpt-5/u`. Auth is resolved before model creation via `resolveExternalCliCredential()` in `src/auth/external-cli-auth.ts`, which runs `gh auth token` and injects the credential into `process.env` for the current process only.
- **baseten / fireworks / nebius / nvidia / openai-compatible** → `ChatOpenAI` with the provider's API key and optional custom `baseURL` from `PROVIDER_CONFIGS`; `useResponsesApi` is resolved by `providerUsesResponsesApi()`, which for `openai-compatible` honors the `OPENWIKI_OPENAI_COMPATIBLE_USE_RESPONSES_API` opt-in (default chat completions) and is `false` for the others. For `openai-compatible`, `OPENWIKI_OPENAI_COMPATIBLE_STREAMING=true` spreads `streaming: true` to force the HTTP streaming transport for gateways that only serve SSE. NVIDIA NIM reasoning-capable models (e.g. Nemotron 3 Super) read `OPENWIKI_REASONING_EFFORT` through the chat-completions `reasoning_effort` field.

Credential gating before model creation uses `getMissingProviderEnvKey()` in `src/config/constants.ts`, which requires the provider's API key — or `GOOGLE_CLOUD_PROJECT` for gemini-enterprise — and powers the same check in the CLI's non-interactive gates and the onboarding flow.

### Reasoning effort

`OPENWIKI_REASONING_EFFORT` configures reasoning for supported provider/model pairs via `src/config/reasoning.ts`. The `REASONING_CAPABILITIES` table maps a `(provider, modelId)` to a transport and an allowlist of effort values: OpenAI and ChatGPT GPT-5.6 models use the Responses API transport (`reasoning: { effort }`), while NVIDIA NIM's Nemotron 3 Super uses the chat-completions `reasoning_effort` field. `resolveReasoningConfig()` is the single validation gate — it throws before a request is sent when the env value is not a known effort, the provider/model pair is unsupported, or the effort is not in the pair's allowlist — and `createModel()` spreads the resolved options into the matching branch. The interactive `/effort` slash command and the onboarding `reasoning-effort` step both derive their selectable rows from the same capability table via `getReasoningCapability()`, so an unsupported combination offers no value rather than failing at request time. A shell export of `OPENWIKI_REASONING_EFFORT` takes precedence over the saved `~/.openwiki/.env` value until the next process, so the interactive UI warns when a saved choice is shadowed.

### DeepAgents backend and middleware

The agent uses a DeepAgents `LocalShellBackend` rooted at the repository, configured with `virtualMode: true`, `maxOutputBytes: 100_000`, and a 120 second timeout. A SQLite checkpointer (`~/.openwiki/openwiki.sqlite`) persists conversation threads keyed by a hash of the repository path.

`createAgentBackend()` in `src/agent/index.ts` wraps that wiki backend in an `OpenWikiCompositeBackend` (a DeepAgents `CompositeBackend` subclass) that layers two read-only virtual mounts on top of the documented repository:

- `/skills/` — the bundled and user skills under `~/.openwiki/skills` (populated by `src/agent/skills.ts`).
- `/conversation_history/` — the DeepAgents summarization middleware's history offload, routed to `~/.openwiki/conversation_history` (created by `ensureOpenWikiHome()` in `src/config/openwiki-home.ts`). `createDeepAgent` exposes no way to override the `/conversation_history` default prefix, so the mount prefix is kept in sync with it via the exported `CONVERSATION_HISTORY_MOUNT` constant. Routing the offload outside the repository is what lets it succeed on docs-only `--init`/`--update` runs: without the mount, the docs-only write guard refuses the offload write, that refusal is non-fatal, and summarization silently degrades — narrowing coverage on large repositories while the run still exits 0 (#496).

Both mounts are denied to the model's own filesystem tools via `AGENT_FILESYSTEM_PERMISSIONS` (`/skills/**` and `/conversation_history/**`, `mode: "deny"` for writes). The summarization middleware writes directly through the backend, which agent-layer permissions do not affect, so the offload keeps working while prompt-injected `write_file` calls into either mount are refused.

The agent runtime attaches two middleware layers:

- **OKF index middleware** (`src/agent/okf-middleware.ts`): migrates existing pages to valid OKF front matter before the agent runs, validates front matter on every write (decorating successful tool results with warnings, never catching tool throws), and synchronizes directory `index.md` files after the run. Preparation and finalization are delegated to the shared [wiki finalizer](../agent/workflow.md#generated-provenance-stamping) (`src/agent/wiki-finalizer.ts`): `beforeAgent` calls `prepareWikiForAuthoring()` (migrate + provenance snapshot), and `afterAgent` calls `finalizeWikiArtifacts()`, which runs Mermaid validation, index synchronization, internal link validation, claims-sources projection (when a Claims runtime supplies evidence resources), and `generated` provenance reconciliation in that order. The code-owned `generated` provenance is finalized in a snapshot-and-reconcile pass owned by `src/okf/generated-provenance.ts`: `beforeAgent` snapshots every concept's exact body hash (SHA-256, front matter stripped, whitespace retained) and prior `generated` event; `afterAgent` re-walks the tree _after_ all post-processing and stamps `generated: {by: openwiki/<version>, at: <run time>}` on every new or body-changed page (any body difference, including whitespace, advances the stamp), restores the prior event on unchanged bodies that an agent rewrite dropped, and leaves previously-unstamped unchanged pages unstamped. A front-matter-only change does not bump `generated`. The producer actor (`OPENWIKI_PRODUCER_ACTOR = openwiki/${OPENWIKI_VERSION}` in `src/version.ts`) and the run time are the single `by`/`at` source, so freshness never rests on a hallucinated date and every page changed in one run shares one `generated.at`. For host-authored runs (Codex, Claude Code), the host's `producerActor` (e.g. `codex`, `claude-code`) is stamped instead, distinguishing host-authored page bodies from native agent runs. Unlike the earlier per-write path, finalization throws on a persist failure (wrapped in `inStage("finalize", …)` as `okf_error`/`generated_provenance`) rather than swallowing it. Reserved `index.md`/`log.md` and non-`.md` paths are excluded by `listWikiConceptPaths()`. Its `afterAgent` finalize stage runs validation passes before provenance: Mermaid fences via `src/mermaid/wiki.ts`, index synchronization, internal link validation via `src/agent/wiki-link-validator.ts`, and claims-sources projection via `src/okf/claim-sources.ts`. The link validator resolves targets against the whole repository (not just the `openwiki/` subtree), since wiki pages may legitimately link out to repo files that render on GitHub; a link is broken only when its target genuinely does not exist. Heading anchors are validated only against Markdown targets, so directory links and GitHub line anchors on source files (e.g. `#L10`) are never flagged. `slugifyHeading` mirrors `github-slugger` (keeps combining marks, replaces whitespace per-character without collapsing) so anchors like `a--b` from stripped punctuation resolve. Broken links are stamped inline with `openwiki:` HTML comments instead of failing the run — the same degrade-and-self-repair pattern Mermaid uses — so a later update can repair the href from the inline comment.
- **Translation middleware** (`src/agent/translation-middleware.ts`): when the output language differs from the wiki's current language, translates all eligible pages before the agent runs. Pages marked `openwiki_translation_pending` from a prior failed run are retranslated individually. The middleware tags its LLM calls with `langsmith:nostream` so translation output does not scroll past in the TUI token stream.

### Content snapshot and metadata writes

After a non-chat run completes, `src/agent/utils.ts` computes a SHA-256 snapshot of the `openwiki/` directory (excluding `.last-update.json`). `persistRunMetadataIfChanged()` always refreshes `openwiki/.last-update.json` for non-chat runs (not only when the snapshot changed) so freshness checks reflect the actual last run rather than the last content change — the fast-skip no-op path in `runOpenWikiAgent` also calls `writeLastUpdateMetadata()`, carrying the persisted `language` surfaced by `getUpdateNoopStatus()` so a non-English wiki keeps its marker. A completed retry that changed no content still clears a previous `interrupted` status so the update no-op check can skip again. The snapshot still guards against endless content-update loops in scheduled workflows by scoping the git change summary.

### Auto-exit behavior

`shouldAutoExitStartupRun()` in `src/cli/cli.tsx` determines whether a startup run should exit automatically on success. This applies to `--init` and `--update` commands (without `--print`) when run in a TTY: the CLI launches the run, renders streaming output, and exits with code 0 on success. Chat runs and `--print` runs are unaffected.

### Streaming and crash guard

The live run consumes the agent via `agent.stream({ streamMode, subgraphs: true })` rather than the Agent Protocol `streamEvents` API. `streamMode` is conditional: most providers use `["messages", "tools"]`, but the `openai-compatible` provider defaults to `["updates", "tools"]` (resolved via `streamMessagesEnabled = provider !== "openai-compatible" || resolveOpenAiCompatibleStreamMessages()`), because `messages` mode routes the model through `_streamResponseChunks` chunk aggregation and endpoints that stream reasoning deltas before the first `role:"assistant"` delta (z.ai GLM) aggregate to a `ChatMessageChunk` the agent loop's `wrapModelCall` validator rejects (issue #659). `OPENWIKI_OPENAI_COMPATIBLE_STREAM_MESSAGES=true` opts back into `messages` mode for known-good endpoints. `parseAgentStreamChunk()` in `src/agent/index.ts` normalizes each `[namespace, mode, payload]` chunk into an `OpenWikiRunEvent`: `tools` chunks become tool start/end events (tool-call strings pass through `sanitizeDiagnosticText()` so secrets are redacted), and `messages` chunks yield text after `extractMessageText()` filters non-text content blocks (`tool`, `reasoning`, `file`, `image`) so base64 payloads never reach the terminal. A namespace longer than one element marks the event `source: "subgraph"`, which is how init subagent output is attributed. `parseStreamEvent()` remains exported for the public agent factory's Agent Protocol v3 event shape, but the live run no longer uses it.

A process-wide crash guard (`src/agent/crash-guard.ts`) is installed once at CLI startup via `installCrashGuard()`. The run registers itself with `registerActiveRun()` for the stream-consumption window only and clears it in `finally`; if a rejection escapes every catch (e.g. a subagent error on the microtask queue), `handleFatal()` records the failure to telemetry, stamps the run `interrupted`, and exits non-zero. `handleFatal()` claims the active run synchronously — `getActiveRun()` followed immediately by `clearActiveRun()` with no `await` between them, before any async side effect — so a burst of escaped rejections landing together on the microtask queue produces one crash event: the first handler wins the run and every later handler sees `undefined` and only exits. Do not move an `await` above that pair; doing so reintroduces the race where one crash records hundreds of duplicate events. See [Agent workflow § Crash guard](../agent/workflow.md#crash-guard) for the post-mortem contract.

## Why the architecture is shaped this way

The current design reflects a documentation product rather than a general-purpose agent framework:

- The CLI owns user experience and credential bootstrap so the tool is install-and-run friendly.
- Git evidence is gathered by the agent itself during the run (per the prompt templates), so the model can adapt its discovery to the actual change window rather than consuming a fixed precomputed summary.
- Provider support is centralized in `src/config/constants.ts` so adding a provider is a single-config change plus a model-creation branch.
- Model execution is provider-stable: transient request failures can retry through the selected LangChain model client, but OpenWiki surfaces the final error instead of continuing with another model.
- The content-snapshot check scopes the git change summary and gates interrupted-status recovery, while metadata is now always refreshed so freshness checks reflect the actual last run — both matter for scheduled CI workflows.
- Auto-exit for init/update makes the CLI usable in both interactive and one-shot contexts without requiring `--print`.

## Major extension points

- Add or refine CLI commands in `src/cli/commands.ts` and the corresponding UI behavior in `src/cli/app/app.tsx` and `src/cli/cli.tsx`.
- Change onboarding or local credential storage in `src/setup/credentials.tsx` (with `src/setup/credentials/` modules) and `src/config/env.ts`.
- Add a new model provider by extending `PROVIDER_CONFIGS` and `OpenWikiProvider` in `src/config/constants.ts`, then adding a branch in `createModel` in `src/agent/index.ts`.
- Adjust model defaults, validation, or fallback lists in `src/config/constants.ts`.
- Extend the documentation prompt or Git evidence in `src/agent/prompts/code.ts`, `src/agent/prompts/personal.ts`, and `src/agent/prompt.ts` (assembler); run persistence and snapshot behavior live in `src/agent/utils.ts`.

## Supporting subsystems

- **OKF compliance** (`src/okf/`): `frontmatter.ts` validates and migrates YAML front matter, `index-labels.ts` localizes directory index headings by BCP-47 language, `index-sync.ts` deterministically generates and synchronizes every `index.md` after a run (the root index declares `okf_version: "0.2"`) and exposes `listWikiConceptPaths()` for the snapshot/finalize pass, `generated-provenance.ts` owns the code-owned `generated` stamp via `snapshotGeneratedProvenance()` / `finalizeGeneratedProvenance()` / `restoreGeneratedEvent()` (exact body SHA-256, no whitespace normalization), `claim-sources.ts` projects Claims evidence resources into the OKF `sources` front-matter field with deterministic `openwiki-source-` prefixed IDs, and `claims-verification.ts` projects the durable Claims verification event into the OKF `verified` field while retaining human and process events. The OKF middleware (`src/agent/okf-middleware.ts`) ties these into the agent lifecycle. `validateOkfFrontmatter()` enforces OKF v0.2: `type` is the only required field; optional scalar string fields (`title`, `description`, `resource`, `timestamp`), `tags` (a string list), and the v0.2 provenance/trust/lifecycle families are validated when present — `generated` and `verified` as `{by, at}` actor events (a bare `verified` mapping is read as a one-element list), `sources` as a list of mappings each with a non-empty `resource`, `status` one of `draft`/`stable`/`deprecated`, and `stale_after` an absolute `YYYY-MM-DD`. The legacy v0.1 `timestamp` is still tolerated (SPEC §13.1 fallback) but superseded by the code-owned `generated` stamp. The front-matter helpers own provenance round-tripping without destroying producer extensions: `setGeneratedEvent()` writes/replaces a `generated: {by, at}` flow mapping, `removeFrontmatterField()` drops a field byte-for-byte, `setOkfSources()` / `setOkfVerified()` project Claims-owned fields, and `normalizeConceptContent()` rebuilds a type-less page while carrying `openwiki_translation_pending` (scalar) and `generated` (structured) across the rebuild via the preserved-field lists.
- **Grounded Claims** (`src/claims/`): page-owned factual propositions persisted as JSON sidecars under `openwiki/.claims/`. See [Grounded Claims](../claims/grounded-claims.md) for the full architecture. The core layer (`core/types.ts`, `core/mutations.ts`, `core/errors.ts`, `core/resolver-cache.ts`) defines the claim/operation/evidence types and the atomic `applyClaimOperations()` mutation engine. The repository evidence resolver (`evidence/repository/resolver.ts`, `resource.ts`) resolves `repo://path#Lx-Ly` resources against the working tree with path-containment and `.openwikiignore` enforcement, and carries relocation metadata in the opaque version token so shifted line ranges can be relocated. The code brain (`brains/code/`) owns the session (`session.ts`), store (`store.ts`), agent tools (`tools.ts`), read-note middleware (`middleware.ts`), preflight (`preflight.ts`), runtime (`runtime.ts`), and integration wiring (`integration.ts`). `prepareClaimsRuntime()` prepares the runtime for repository init/update runs only; chat and personal-brain runs get no Claims tools.
- **Mermaid validation** (`src/mermaid/`): `fences.ts` extracts Mermaid code fences from wiki pages, `validate.ts` parses and validates them, and `wiki.ts` repairs broken fences by converting them to plain text fences with an HTML comment explaining the parse error. The OKF middleware calls `validateWikiMermaid()` after every run.
- **Telemetry** (`src/telemetry/`): emits a single `openwiki_run` PostHog event per run with mode, provider, outcome, latency, configured connectors, and a build channel. `gates.ts` checks `OPENWIKI_TELEMETRY_DISABLED` / `DO_NOT_TRACK` for opt-out, uses `ci-info` to tag CI runs with a sentinel distinct ID so ephemeral runners never inflate install counts, and bakes a `BUILD_CHANNEL` (`"community"` in committed source, stamped to `"official"` only on the upstream release path — see [Credentials and updates § Build channel stamping](../operations/credentials-and-updates.md#build-channel-stamping)) so every event carries it and the dashboard can filter fork-originated telemetry. `record-run-safe.ts` wraps the send with a 3-second flush timeout so telemetry can never stall the CLI. `errors.ts` classifies failures by walking an unwrap chain (`unwrapErrorChain()`, bounded at 32 links, cycle-safe) so a provider error buried under several framework envelopes is recovered instead of collapsing into the residual `agent_error` bucket, with one origin-tag override (`streamOpenDisguisesProvider()`) that reclassifies a `build_error/stream_open` tag masking a provider failure. The residual `agent_error` bucket's one signal is the innermost error's own allowlisted name, folded into `error_detail` via `innermostErrorName()`; see [Credentials and updates § Error classification and fingerprinting](../operations/credentials-and-updates.md#error-classification-and-fingerprinting) for the full taxonomy, identifier allowlist, and override rules. `client.ts` `capture()` returns `true` only when the PostHog send fulfills before the flush timeout, so send failures and timeouts are reported as failures rather than silently swallowed.
- **Skills** (`src/agent/skills.ts`): bundles the `skills/` directory into the OpenWiki home and exposes it to the agent as the `/skills/` virtual mount on the `CompositeBackend` built by `createAgentBackend()` (see [DeepAgents backend and middleware](#deepagents-backend-and-middleware)). Write access to `/skills/**` is denied to the model via `AGENT_FILESYSTEM_PERMISSIONS`. Each bundled skill is staged in a unique scratch directory and swapped into place with an atomic `rename`, so repeated or overlapping `--init` syncs are idempotent — a concurrent install that lands first is accepted as success rather than racing with `EEXIST` or `ENOTEMPTY` errors. Before the swap, `grantOwnerWrite()` recursively adds the owner-write bit across the staged tree (skipping symlinks), so a bundled skill shipped read-only (the Nix store and immutable container images mount `skills/` as `dr-xr-xr-x`) yields a writable, self-healing installed copy whose `rename` and `finally` cleanup both succeed.
- **Diagnostics and redaction** (`src/platform/diagnostics.ts`): redacts secrets from error messages, headers, and provider responses before they are shown to the user or written to logs. It matches exact secret values from the environment and known token shapes (`sk-…`, `Bearer …`, `ls…`).
- **Coding-agent integrations** (`src/integrations/`): deploys OpenWiki as a skill bundle and MCP server into external coding agents. See [Coding-agent integrations](../integrations/coding-agents.md) for the full architecture. The `install/` layer is a transactional installer (`HostIntegrationInstaller`) that stages the skill bundle, snapshots existing MCP config, and rolls back on failure. The `core/` layer defines the transport-neutral lifecycle protocol (`protocol.ts`) and the in-process session manager (`session-manager.ts`) that owns the begin/finish lifecycle, reusing the same Claims runtime and wiki finalizer as the native agent. The `mcp/` layer adapts the protocol to a stdio MCP server (`server.ts`, `stdio.ts`).
- **Untrusted-text sanitization** (`src/platform/utils.ts`): `stripHtmlTags()` removes angle brackets from markdown token text, and `stripTerminalControlSequences()` strips ANSI/VT escape, CSI, OSC, DCS, SOS, PM, and APC sequences plus non-whitespace C0/C1 controls from streamed model output before the Ink markdown renderer lexes it. Newlines and tabs are preserved as useful Markdown whitespace; other C0/C1 controls are discarded rather than passed to a terminal emulator. `MarkdownText` in `src/cli/components/markdown.tsx` applies `stripTerminalControlSequences()` before `marked.lexer`, so a prompt-injected escape sequence in model output can no longer reformat the terminal (#550).

## Things to watch when editing

- `src/cli/cli.tsx` and `src/cli/commands.ts` must stay aligned; help text and parser behavior are intentionally coupled.
- Credential setup writes to a real home-directory file, so permission handling matters.
- The agent is expected to work from repository-local virtual paths like `/README.md` and `/openwiki/quickstart.md`; the prompt explicitly warns about this.
- `openwiki/` in the target repository is both the docs output location and the metadata location for `.last-update.json`.
- When adding a provider, update `managedEnvKeys` in `src/config/env.ts` so diagnostics and env formatting cover the new key.
- The content-snapshot logic excludes `.last-update.json`; if new metadata files are added under `openwiki/`, decide whether they should be excluded too.
- Claims sidecars live under `openwiki/.claims/` and are OpenWiki-owned; never edit them directly. The agent maintains them through `resolve_claims`/`inspect_claims` only. See [Grounded Claims](../claims/grounded-claims.md).
- The wiki finalizer (`src/agent/wiki-finalizer.ts`) is shared by the OKF middleware and the MCP host session manager; changes to the finalization order affect both the native agent and host-authored runs.
- When adding a new coding-agent host, extend `HOST_TARGETS` in `src/integrations/install/registry.ts` and add a config adapter in `src/integrations/install/` if the host's MCP config format differs from JSON or Codex TOML. See [Coding-agent integrations](../integrations/coding-agents.md).

## Source map

- `src/cli/cli.tsx`
- `src/cli/app/app.tsx`
- `src/cli/commands.ts`
- `src/cli/runners.ts`
- `src/cli/startup.ts`
- `src/setup/credentials.tsx` (re-exports `src/setup/credentials/`)
- `src/config/env.ts`
- `src/config/constants.ts`
- `src/config/reasoning.ts`
- `src/agent/index.ts`
- `src/model-availability.ts`
- `src/agent/prompt.ts`
- `src/agent/prompts/code.ts`
- `src/agent/prompts/personal.ts`
- `src/agent/skeleton-critic.ts`
- `src/agent/wiki-qa-subagents.ts`
- `src/agent/review-subagents.ts`
- `src/agent/wiki-finalizer.ts`
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
- `src/okf/frontmatter.ts`, `src/okf/index-labels.ts`, `src/okf/index-sync.ts`, `src/okf/generated-provenance.ts`, `src/okf/claim-sources.ts`, `src/okf/claims-verification.ts`
- `src/claims/` (guidance.ts, core/types.ts, core/mutations.ts, core/errors.ts, core/resolver-cache.ts, evidence/repository/resolver.ts, evidence/repository/resource.ts, brains/code/types.ts, brains/code/session.ts, brains/code/store.ts, brains/code/tools.ts, brains/code/middleware.ts, brains/code/preflight.ts, brains/code/runtime.ts, brains/code/integration.ts, brains/code/paths.ts)
- `src/integrations/` (core/protocol.ts, core/session-manager.ts, core/errors.ts, core/repository-root.ts, install/installer.ts, install/registry.ts, install/types.ts, install/skill-bundle.ts, install/install-paths.ts, install/config-json.ts, install/config-toml.ts, install/atomic-file.ts, mcp/server.ts, mcp/stdio.ts)
- `src/cli/integrations.ts`
- `src/version.ts` (exports `OPENWIKI_VERSION` read from `package.json` at runtime, and `OPENWIKI_PRODUCER_ACTOR = openwiki/${OPENWIKI_VERSION}` — the `by` actor stamped on `generated` events)
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
