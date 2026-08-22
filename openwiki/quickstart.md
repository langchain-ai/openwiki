---
type: Quickstart Guide
title: OpenWiki Quickstart
description: Quickstart reference for the OpenWiki TypeScript CLI, including documentation-generation workflows, supported model providers, and the primary source files. Use it to navigate the repository's architecture, commands, agent runtime, operations, and connectors.
tags: [openwiki, quickstart, cli, documentation]
generated: {by: "openwiki/0.3.3", at: "2026-08-22T08:06:14.226Z"}
sources:
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-a953060a04ccefcf777de48e
    resource: repo://src/agent/index.ts
  - id: openwiki-source-6fd9c8ed42336141de43b3c2
    resource: repo://src/agent/okf-middleware.ts
  - id: openwiki-source-e6e6ad50adcacff30c80660c
    resource: repo://src/agent/prompts/code.ts
  - id: openwiki-source-21ff9512e70f21e9b1cd2d0f
    resource: repo://src/agent/review-subagents.ts
  - id: openwiki-source-adcadc660c1888613ec50f9a
    resource: repo://src/agent/wiki-finalizer.ts
  - id: openwiki-source-9697823032111d36e2d4caa9
    resource: repo://src/agent/wiki-replacement.ts
  - id: openwiki-source-239b2968fb2bcd073e89cedc
    resource: repo://src/claims/brains/code/runtime.ts
  - id: openwiki-source-3fc16f0371ced4d94330f06c
    resource: repo://src/cli/commands.ts
  - id: openwiki-source-6f06cc988142430d18f2233e
    resource: repo://src/integrations/mcp/stdio.ts
verified:
  - by: openwiki/0.3.3
    at: 2026-08-22T08:06:14.226Z
---

# OpenWiki quickstart

OpenWiki is a TypeScript CLI that writes and maintains documentation for a repository using an agent-driven workflow. The package exposes a single `openwiki` binary (entrypoint `./dist/cli/cli.js`), stores local credentials in `~/.openwiki/.env`, and records successful update metadata in `openwiki/.last-update.json`.

## What this repository does

- Launches an interactive Ink-based terminal app for chatting with the OpenWiki agent.
- Supports one-shot documentation runs with `--init`, `--update`, and `--print`. Running `--init` again regenerates the repository wiki from scratch, replacing the existing generated wiki (pages, Claims sidecars, indexes, run metadata) with a brand-new generation while preserving the user-authored `openwiki/INSTRUCTIONS.md` and restoring the previous wiki if generation fails or is cancelled — see [Agent workflow § Wiki replacement on init](./agent/workflow.md#wiki-replacement-on-init).
- Supports multiple model providers — OpenAI (default, API key or ChatGPT OAuth login), GitHub Copilot (via GitHub CLI), OpenRouter, Anthropic, Gemini (AI Studio), Gemini Enterprise (Vertex AI, keyless via Google ADC), AWS Bedrock, Nebius Token Factory, Baseten, Fireworks, NVIDIA NIM, and any OpenAI-compatible gateway — each with their own credentials and model list (Gemini Enterprise uses Google ADC instead of an API key; Bedrock uses AWS access/secret keys and region; Copilot uses the GitHub CLI for auth).
- Uses a DeepAgents local shell backend with virtual filesystem paths rooted at the target repository.
- Creates or refreshes documentation under the target repository's `openwiki/` directory.
- Auto-exits after successful `--init` or `--update` runs in an interactive terminal, so the CLI works as both a one-shot and interactive tool.
- Optionally schedules automated updates through GitHub Actions, GitLab CI, or Bitbucket Pipelines.
- Maintains page-owned, evidence-backed factual propositions (Grounded Claims) as JSON sidecars under `openwiki/.claims/`, exposing `resolve_claims` and `inspect_claims` tools to the agent and projecting evidence and verification into OKF `sources` and `verified` front matter.
- Serves as an MCP tool server for external coding agents (Codex, Claude Code) via `openwiki integrations install <codex|claude>` and `openwiki mcp --host <id>`, exposing a begin/inspect_claims/resolve_claims/finish lifecycle protocol so host agents author wikis with the same Claims discipline as the native CLI.
- Ships two sibling evaluation harnesses: a paired DeepSWE evaluation harness (`evals/deepswe/`) that measures OpenWiki's documentation leverage on a Codex coding agent, and a LEDGER longitudinal benchmark (`evals/ledger/`) that replays a source repository's Git checkpoints, runs OpenWiki at each, and evaluates every current factual claim as supported, stale, hallucinated, or unverified.
- Serves an interactive node-graph visualizer (`openwiki visualize`) for an already-generated wiki, with live edits refreshed over SSE, and can export a self-contained static visualizer directory (`openwiki visualize --export <dir>`) hostable on any static host.
- Honors a repo-root `.openwikiignore` file as a read boundary that keeps private/generated paths out of doc runs.
- Generates the wiki in a non-English language with `--language <locale>` (BCP-47); the language is persisted and retranslated on a switch via the translation middleware. A `--language` switch to a different primary subtag defeats the update no-op skip on a clean tree, so the translation pass runs even when no source changed.
- Stamps a `build_channel` (`official` / `community`) into each telemetry event at build time so fork-originated telemetry can be filtered from the official-release signal.
- Validates the selected OpenAI model against the API key's model catalogue before inference, aborting early when the model is unavailable to the configured credentials.
- Caps OpenRouter per-request output tokens with `OPENWIKI_OPENROUTER_MAX_TOKENS` to avoid 402 credit-pre-check failures on low balances.
- Lets the openai-compatible provider opt into OpenAI's Responses API with `OPENWIKI_OPENAI_COMPATIBLE_USE_RESPONSES_API=true` (default chat completions), so a gateway exposing a Responses-compatible endpoint uses the Responses-API tool-calling/SSE path. The openai-compatible provider also defaults to non-streaming `updates` stream mode (instead of `messages`) to avoid a `ChatMessageChunk` validator crash on endpoints that stream reasoning deltas before the first `role:"assistant"` delta (z.ai GLM, issue #659); set `OPENWIKI_OPENAI_COMPATIBLE_STREAM_MESSAGES=true` to restore live token streaming for known-good endpoints. Separately, `OPENWIKI_OPENAI_COMPATIBLE_STREAMING=true` forces the HTTP streaming transport (SSE) for gateways that only serve the streaming transport and otherwise return HTTP 200 with empty content (#655).
- Caps per-request output tokens with `OPENWIKI_MAX_OUTPUT_TOKENS` (positive integer), applied as `maxTokens`/`maxOutputTokens` across every provider's model client; and for the Bedrock provider exposes `OPENWIKI_STREAM_IDLE_TIMEOUT` (milliseconds, `0` disables the watchdog) to control how long the client waits for the first or next streamed chunk.
- Configures reasoning effort with `OPENWIKI_REASONING_EFFORT` for supported OpenAI GPT-5.6 models (Responses API `none`/`low`/`medium`/`high`/`xhigh`/`max`) and NVIDIA NIM Nemotron 3 Super (`none`/`low`/`high` via chat-completions `reasoning_effort`), selectable interactively via `/effort`; invalid provider/model/effort combinations fail before a request is sent.
- Refreshes `openwiki/.last-update.json` on every non-chat run (not only when content changed) so freshness checks reflect the actual last run, while still scoping the git change summary and interrupted-status recovery with the content snapshot.
- Offers a built-in `custom-mcp` connector so a personal-wiki run can ingest from any read-only MCP server without a dedicated connector, and gates all connector tools to personal/local-wiki runs so code-mode runs never make credentialed external fetches.
- Emits OKF v0.2 concept front matter and stamps the code-owned `generated: {by: openwiki/<version>, at: <run time>}` provenance event deterministically on every concept whose body changes in any way (including whitespace), finalized after post-processing so a full-file rewrite that drops the field still gets an accurate stamp; the v0.2 provenance/trust/lifecycle families (`generated`, `verified`, `sources`, `status`, `stale_after`) are validated when present (the legacy `timestamp` stays tolerated).

## Start here

- [Architecture overview](./architecture/overview.md) — runtime structure, major modules, and execution flow.
- [CLI usage](./cli/usage.md) — commands, options, model/provider selection, and credential bootstrap.
- [Agent workflow](./agent/workflow.md) — how documentation runs are assembled and persisted.
- [Credentials and updates](./operations/credentials-and-updates.md) — local env storage, metadata, and scheduled updates.
- [Connectors](./integrations/connectors.md) — built-in connector architecture, the nine connectors (including the generic Custom MCP source), and ingestion orchestration.
- [Coding-agent integrations](./integrations/coding-agents.md) — MCP skill+server installation for Codex and Claude Code, the begin/finish lifecycle protocol, and the transactional installer.
- [Grounded Claims](./claims/grounded-claims.md) — page-owned factual propositions with evidence resolution, mutation operations, and OKF `sources`/`verified` projection.
- [DeepSWE evaluation harness](./evals/deepswe-harness.md) — paired DeepSWE benchmark harness that measures OpenWiki's documentation leverage on Codex.
- [LEDGER longitudinal benchmark](./evals/ledger-harness.md) — source-grounded benchmark that replays Git checkpoints, runs OpenWiki at each, and scores per-claim grounding and forgetting.

## Key source files

- `README.md` — user-facing installation and usage summary.
- `package.json` — bin entrypoint, scripts, and dependencies.
- `src/cli/cli.tsx` — process entrypoint: parses argv, loads env, and dispatches to the interactive app, print runner, or operational subcommands.
- `src/cli/app/app.tsx` — Ink interactive app shell: chat, run lifecycle, provider/model selection, and streaming.
- `src/cli/commands.ts` — CLI parsing and help content.
- `src/cli/runners.ts` — non-interactive runners for auth, ngrok, cron, ingest, visualize (live server and `--export` static export), and print commands.
- `src/cli/startup.ts` — `resolveStartupCommand()` and startup gating helpers, including `canSkipCleanUpdateBeforeCredentials()` which calls `getUpdateNoopStatus()` with the requested language so a `--language` switch is not skipped before credentials are even checked.
- `src/cli/diagnostics/` — `error-diagnostics.ts`, `sanitize.ts`, and `auth-fix.ts` for the `--debug` diagnostics panel and auth-failure fix guidance.
- `src/cli/run-log/` — bounded progress model for init/update terminal output: `reducer.ts` folds run events into one summary + activity tree + final text, `activity.ts` derives path operations and builds the tree, `summary.ts` formats counts and completion titles, `tool-input.ts` parses stringified tool args, and `types.ts` defines the `RunLogItem` union.
- `src/cli/components/run-view.tsx` — `RunView` Ink component rendering the live activity tree, run stage, and completed-run outcome (written pages, counts, final assistant text).
- `src/agent/index.ts` — agent runtime, provider-specific model creation (including ChatGPT OAuth), OpenAI model-availability pre-check, fallback, and metadata writes.
- `src/agent/prompt.ts` — prompt assembler: selects a template by output mode and substitutes placeholders.
- `src/agent/prompts/code.ts` — `CODE_SYSTEM_PROMPTS`/`CODE_USER_PROMPTS` for repository runs (init/update/chat contracts, including the Claims-first authoring workflow and the skeleton-critic and wiki-QA verification subagents).
- `src/agent/prompts/personal.ts` — `PERSONAL_SYSTEM_PROMPTS`/`PERSONAL_USER_PROMPTS` for local personal-brain runs.
- `src/agent/review-subagents.ts` — `resolveRepositoryReviewSubagents()` consolidates the init-only `skeleton-critic`, `wiki-question-finder`, and `wiki-answer-verifier` subagents, wrapping each with a read-only filesystem middleware (read_file, ls, glob, grep only).
- `src/agent/skeleton-critic.ts` — `skeleton_critic` init-only subagent that reviews the proposed wiki plan against the repository.
- `src/agent/wiki-qa-subagents.ts` — `wiki_question_finder` and `wiki_answer_verifier` init-only subagents that verify the completed wiki answers source-grounded questions.
- `src/agent/crash-guard.ts` — process-wide `installCrashGuard()` + `registerActiveRun`/`handleFatal` that records and stamps an escaped rejection as an interrupted run; `handleFatal` claims the active run synchronously so a burst of escaped rejections records one crash.
- `src/agent/utils.ts` — run context, content snapshot, and `.last-update.json` handling; `getUpdateNoopStatus()` (now language-aware) decides whether an update can skip.
- `src/agent/types.ts` — shared agent types (`OpenWikiCommand`, `RunContext`, `UpdateMetadata`, run options/events).
- `src/agent/docs-only-backend.ts` — `OpenWikiLocalShellBackend`, extends DeepAgents `LocalShellBackend` with docs-only write guards and output-mode awareness.
- `src/agent/openai-chatgpt-oauth.ts` — ChatGPT OAuth flow, token persistence, and refresh logic for the `openai-chatgpt` provider.
- `src/auth/oauth.ts` — generic OAuth runner for connector providers (Gmail, Notion, Slack, X).
- `src/auth/oauth-discovery.ts` — OAuth endpoint validation and protected-resource metadata discovery for connector OAuth flows.
- `src/auth/providers.ts` — connector OAuth provider configs (scopes, token URLs, env-key mappings).
- `src/auth/configure.ts` — `openwiki auth configure <provider>` flow for creating local connector configs.
- `src/auth/ngrok.ts` — Slack HTTPS callback tunnel via ngrok.
- `src/auth/tokens.ts` — token refresh and validation helpers for connector OAuth.
- `src/agent/okf-middleware.ts` — OKF front-matter migration, write validation, and index synchronization middleware; its `beforeAgent` snapshots concept bodies and its `afterAgent` finalize stage finalizes `generated` provenance (via `src/agent/wiki-finalizer.ts`), validates Mermaid fences, synchronizes indexes, validates internal wiki links, and projects Claims evidence into OKF `sources`.
- `src/agent/wiki-finalizer.ts` — `prepareWikiForAuthoring()` and `finalizeWikiArtifacts()`, the shared deterministic wiki lifecycle pipeline used by both the OKF middleware and the MCP host session manager (migrate, provenance snapshot, Mermaid, index sync, link validation, claims sources, generated provenance).
- `src/agent/wiki-link-validator.ts` — validates internal links repo-wide (not just the `openwiki/` subtree) and GitHub-style heading anchors on Markdown targets after generation, stamping broken links inline instead of failing the run.
- `src/agent/translation-middleware.ts` — wiki translation middleware for output-language switching.
- `src/agent/vertex-surface.ts` — Vertex AI model routing for the gemini-enterprise provider.
- `src/agent/skills.ts` — bundles and syncs the `/skills/` directory into the agent runtime.
- `src/auth/external-cli-auth.ts` — GitHub CLI-based credential resolution for the copilot provider.
- `src/platform/diagnostics.ts` — secret redaction and credential diagnostics.
- `src/okf/` — OKF front-matter validation (v0.2 provenance/trust/lifecycle families), index-label localization, deterministic index synchronization, `generated-provenance.ts` (snapshot/finalize stamping with exact body hashing), `claim-sources.ts` (Projects Claims evidence into OKF `sources`), and `claims-verification.ts` (Projects Claims verification into OKF `verified`).
- `src/claims/` — Grounded Claims system: core types and mutations (`core/`), repository evidence resolver (`evidence/repository/`), and the code brain (`brains/code/`) with session, store, tools, middleware, preflight, runtime, and integration wiring.
- `src/integrations/` — Coding-agent integrations: host lifecycle protocol and session manager (`core/`), transactional skill+MCP installer (`install/`), and stdio MCP server (`mcp/`).
- `src/version.ts` — `OPENWIKI_VERSION` read from `package.json` at runtime, and `OPENWIKI_PRODUCER_ACTOR` (`openwiki/<version>`) stamped as the `by` actor on OKF v0.2 `generated` provenance events.
- `src/mermaid/` — Mermaid fence extraction, validation, and wiki repair.
- `src/telemetry/` — anonymous usage telemetry with PostHog, opt-out, CI sentinel IDs, error classification/fingerprinting, and a baked-in `build_channel` stamp.
- `scripts/stamp-build-channel.cjs` — release-only build-time rewrite of `BUILD_CHANNEL` in `src/telemetry/gates.ts` from `"community"` to `"official"` for npm-published upstream builds, driven by `OPENWIKI_BUILD_CHANNEL` in `.github/workflows/release.yml`.
- `scripts/copy-visualize-assets.cjs` — build step appended to `npm run build` that copies `src/visualize/styles.css` into `dist/visualize/` (tsc does not emit non-TypeScript assets); fails the build when the source is missing or the copy lands empty.
- `src/connectors/` — connector registry, MCP client/runtime, source-specific ingestion (git-repo, gmail, hackernews, langsmith, slack, web-search, x), and tool definitions.
- `src/ingestion/ingestion.ts` — orchestrates source ingestion runs across configured connectors.
- `src/ingestion/code-mode.ts` — `openwiki code` setup: creates the GitHub Actions workflow only when missing (preserving customizations on update) and refreshes AGENTS.md (full instructions) and CLAUDE.md (a pointer to AGENTS.md) snippets.
- `src/config/env.ts` — `~/.openwiki/.env` persistence and credential diagnostics.
- `src/setup/credentials.tsx` — interactive onboarding flow entrypoint (thin re-export over `src/setup/credentials/` modules: `steps.ts`, `view.tsx`, `use-init-setup.ts`, `persistence.ts`, `format.ts`, `constants.ts`, `types.ts`).
- `src/config/constants.ts` — provider configs, model options, env keys, and validation helpers (including `resolveOpenRouterMaxTokens`, `resolveOpenAiCompatibleUseResponsesApi`, `resolveOpenAiCompatibleStreaming`, `resolveMaxOutputTokens`, and `resolveStreamIdleTimeoutForProvider`).
- `src/config/reasoning.ts` — reasoning-effort capability table and `resolveReasoningConfig()` that validates `OPENWIKI_REASONING_EFFORT` for supported OpenAI GPT-5.6 and NVIDIA NIM models.
- `src/cli/input/menu.ts` — slash-command menu state, including `/effort` reasoning-effort rows derived from `getReasoningCapability()`.
- `src/model-availability.ts` — `getSelectedModelAvailability()` validates the selected model against the OpenAI `/models` catalogue before inference; `unavailable` aborts, `unknown` proceeds.
- `examples/openwiki-update.yml` — GitHub Actions scheduled automation example.
- `examples/openwiki-update.gitlab-ci.yml` — GitLab CI scheduled automation example.
- `examples/openwiki-update.bitbucket-pipelines.yml` — Bitbucket Pipelines scheduled automation example.
- `evals/deepswe/run.py` — paired DeepSWE evaluation harness entrypoint (see [DeepSWE evaluation harness](./evals/deepswe-harness.md)).
- `evals/ledger/run.ts` — LEDGER longitudinal benchmark entrypoint: loads a benchmark, replays its Git checkpoints through the OpenWiki system adapter, and evaluates each frozen wiki snapshot (see [LEDGER longitudinal benchmark](./evals/ledger-harness.md)).
- `evals/ledger/reevaluate.ts` — re-evaluates a completed LEDGER run without re-invoking OpenWiki.
- `evals/ledger/system/openwiki-system.ts` — `OpenWikiSystem` adapter that drives `runOpenWikiAgent` (`init`/`update`, `outputMode: "repository"`) against each replayed checkpoint.
- `src/visualize/server.ts` — local loopback HTTP server for `openwiki visualize` (node graph + live reader, SSE reload).
- `src/visualize/static-export.ts` — `exportStaticVisualizer()` writes a self-contained static visualizer directory (`index.html`, `client.js`, `client-lib.js`, `styles.css`, `graph.json`) for `openwiki visualize --export <dir>`. Also exports `loadVisualizerAssets()`, the shared reader for the compiled browser assets used by both the live server and the static exporter.
- `src/visualize/graph.ts` — parses the wiki into concept nodes and Markdown-link edges for the visualizer.
- `src/visualize/page.ts` — branded single-page visualizer app HTML; `renderPage(staticExport)` produces both the live `PAGE` and the static-export `STATIC_PAGE` (with a CSP `<meta>` and sibling `./client.js`), backed by the shared exported `CSP`.
- `src/visualize/styles.css` — standalone stylesheet served at `/styles.css` (live) or `./styles.css` (static export); copied into `dist/visualize/` by `scripts/copy-visualize-assets.cjs` since tsc does not emit non-TypeScript files.
- `src/agent/openwiki-ignore.ts` — `.openwikiignore` parsing and gitignore-compatible matching (read boundary for doc runs).
- `src/platform/language.ts` — `resolveLanguage()` BCP-47 validation/canonicalization for `--language`.

## Documentation map

- [Architecture](./architecture/overview.md)
- [CLI](./cli/usage.md)
- [Agent](./agent/workflow.md)
- [Operations](./operations/credentials-and-updates.md)
- [Connectors](./integrations/connectors.md)
- [Coding-agent integrations](./integrations/coding-agents.md)
- [Grounded Claims](./claims/grounded-claims.md)
- [DeepSWE evaluation harness](./evals/deepswe-harness.md)
- [LEDGER longitudinal benchmark](./evals/ledger-harness.md)

## Notes for future agents

- The repository is intentionally focused: the main product surface is the CLI plus the documentation-generation agent.
- Treat `openwiki/` in this repo as generated documentation output from a future OpenWiki run, not as application source.
- When changing behavior, verify both the CLI parser and the agent prompt/runtime, because user-visible semantics are split across `src/cli/commands.ts`, `src/cli/cli.tsx`, and `src/agent/*`.
- Provider support is centralized in `src/config/constants.ts`. Adding or changing a provider means updating `PROVIDER_CONFIGS`, the `OpenWikiProvider` type, the `SELECTABLE_OPENWIKI_PROVIDERS` list, and the model-creation branch in `src/agent/index.ts`. OAuth-based providers also need an entry in `src/auth/` if they use browser-login flows. Providers without an API key (like `gemini-enterprise`) declare their required env keys (e.g. `projectEnvKey`) in `PROVIDER_CONFIGS` and are gated by `getMissingProviderEnvKey()` instead. External-CLI-auth providers (like `copilot`) declare `authMethod: "external-cli"` and an `externalCliAuthAdapter`, with the login flow handled in `src/auth/external-cli-auth.ts`. AWS SDK providers (like `bedrock`) declare `authMethod: "aws-sdk"` and delegate credential resolution to the AWS SDK chain.

## Source map

- `README.md`
- `package.json`
- `src/cli/cli.tsx`
- `src/cli/app/app.tsx`
- `src/cli/commands.ts`
- `src/cli/runners.ts`
- `src/cli/startup.ts`
- `src/cli/diagnostics/` (`error-diagnostics.ts`, `sanitize.ts`, `auth-fix.ts`)
- `src/cli/run-log/` (`reducer.ts`, `activity.ts`, `summary.ts`, `tool-input.ts`, `types.ts`) — bounded progress model that folds run events into one summary, an activity tree of touched paths, and final outcome text for the terminal run view.
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
- `src/agent/openwiki-ignore.ts`
- `src/auth/oauth.ts`
- `src/auth/oauth-discovery.ts`
- `src/auth/providers.ts`
- `src/auth/configure.ts`
- `src/auth/ngrok.ts`
- `src/auth/tokens.ts`
- `src/auth/types.ts`
- `src/auth/external-cli-auth.ts`
- `src/connectors/registry.ts`
- `src/connectors/tools.ts`
- `src/connectors/types.ts`
- `src/connectors/http.ts`
- `src/connectors/mcp-client.ts`
- `src/connectors/mcp-runtime.ts`
- `src/connectors/io.ts`
- `src/connectors/sources/git-repo.ts`
- `src/connectors/sources/gmail.ts`
- `src/connectors/sources/hackernews.ts`
- `src/connectors/sources/langsmith/` (api.ts, index.ts, repo-config.ts, runs.ts, setup.ts, types.ts)
- `src/connectors/sources/mcp.ts`
- `src/connectors/sources/slack.ts`
- `src/connectors/sources/web-search.ts`
- `src/connectors/sources/x.ts`
- `src/ingestion/ingestion.ts`
- `src/ingestion/code-mode.ts`
- `src/config/env.ts`
- `src/setup/credentials.tsx` (re-exports `src/setup/credentials/`)
- `src/setup/onboarding.ts`
- `src/config/constants.ts`
- `src/config/reasoning.ts`
- `src/auth/external-cli-auth.ts`
- `src/platform/diagnostics.ts`
- `src/platform/utils.ts`
- `src/platform/language.ts`
- `src/okf/` (frontmatter.ts, index-labels.ts, index-sync.ts, generated-provenance.ts, claim-sources.ts, claims-verification.ts)
- `src/claims/` (guidance.ts, core/types.ts, core/mutations.ts, core/errors.ts, core/resolver-cache.ts, evidence/repository/resolver.ts, evidence/repository/resource.ts, brains/code/types.ts, brains/code/session.ts, brains/code/store.ts, brains/code/tools.ts, brains/code/middleware.ts, brains/code/preflight.ts, brains/code/runtime.ts, brains/code/integration.ts, brains/code/paths.ts)
- `src/integrations/` (core/protocol.ts, core/session-manager.ts, core/errors.ts, core/repository-root.ts, install/installer.ts, install/registry.ts, install/types.ts, install/skill-bundle.ts, install/install-paths.ts, install/config-json.ts, install/config-toml.ts, install/atomic-file.ts, mcp/server.ts, mcp/stdio.ts)
- `src/cli/integrations.ts`
- `src/mermaid/` (dom-shim.ts, fences.ts, validate.ts, wiki.ts)
- `src/telemetry/`
- `scripts/stamp-build-channel.cjs`
- `examples/openwiki-update.yml`
- `examples/openwiki-update.gitlab-ci.yml`
- `examples/openwiki-update.bitbucket-pipelines.yml`
- `src/visualize/` (server.ts, static-export.ts, graph.ts, page.ts, client.ts, client-lib.ts, styles.css)
- `src/agent/openwiki-ignore.ts`
- `src/scheduling/schedules.ts`
