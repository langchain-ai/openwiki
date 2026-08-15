---
type: Quickstart Guide
title: OpenWiki Quickstart
description: Quickstart reference for the OpenWiki TypeScript CLI, including documentation-generation workflows, supported model providers, and the primary source files. Use it to navigate the repository's architecture, commands, agent runtime, operations, and connectors.
tags: [openwiki, quickstart, cli, documentation]
---

# OpenWiki quickstart

OpenWiki is a TypeScript CLI that writes and maintains documentation for a repository using an agent-driven workflow. The package exposes a single `openwiki` binary (entrypoint `./dist/cli/cli.js`), stores local credentials in `~/.openwiki/.env`, and records successful update metadata in `openwiki/.last-update.json`.

## What this repository does

- Launches an interactive Ink-based terminal app for chatting with the OpenWiki agent.
- Supports one-shot documentation runs with `--init`, `--update`, and `--print`.
- Supports multiple model providers — OpenAI (default, API key or ChatGPT OAuth login), GitHub Copilot (via GitHub CLI), OpenRouter, Anthropic, Gemini (AI Studio), Gemini Enterprise (Vertex AI, keyless via Google ADC), AWS Bedrock, Nebius Token Factory, Baseten, Fireworks, NVIDIA NIM, and any OpenAI-compatible gateway — each with their own credentials and model list (Gemini Enterprise uses Google ADC instead of an API key; Bedrock uses AWS access/secret keys and region; Copilot uses the GitHub CLI for auth).
- Uses a DeepAgents local shell backend with virtual filesystem paths rooted at the target repository.
- Creates or refreshes documentation under the target repository's `openwiki/` directory.
- Auto-exits after successful `--init` or `--update` runs in an interactive terminal, so the CLI works as both a one-shot and interactive tool.
- Optionally schedules automated updates through GitHub Actions, GitLab CI, or Bitbucket Pipelines.
- Ships two sibling evaluation harnesses: a paired DeepSWE evaluation harness (`evals/deepswe/`) that measures OpenWiki's documentation leverage on a Codex coding agent, and a LEDGER longitudinal benchmark (`evals/ledger/`) that replays a source repository's Git checkpoints, runs OpenWiki at each, and evaluates every current factual claim as supported, stale, hallucinated, or unverified.
- Serves an interactive node-graph visualizer (`openwiki visualize`) for an already-generated wiki, with live edits refreshed over SSE.
- Honors a repo-root `.openwikiignore` file as a read boundary that keeps private/generated paths out of doc runs.
- Generates the wiki in a non-English language with `--language <locale>` (BCP-47); the language is persisted and retranslated on a switch via the translation middleware.
- Stamps a `build_channel` (`official` / `community`) into each telemetry event at build time so fork-originated telemetry can be filtered from the official-release signal.
- Validates the selected OpenAI model against the API key's model catalogue before inference, aborting early when the model is unavailable to the configured credentials.
- Caps OpenRouter per-request output tokens with `OPENWIKI_OPENROUTER_MAX_TOKENS` to avoid 402 credit-pre-check failures on low balances.
- Lets the openai-compatible provider opt into OpenAI's Responses API with `OPENWIKI_OPENAI_COMPATIBLE_USE_RESPONSES_API=true` (default chat completions), so a gateway exposing a Responses-compatible endpoint uses the Responses-API tool-calling/SSE path.
- Offers a built-in `custom-mcp` connector so a personal-wiki run can ingest from any read-only MCP server without a dedicated connector, and gates all connector tools to personal/local-wiki runs so code-mode runs never make credentialed external fetches.

## Start here

- [Architecture overview](./architecture/overview.md) — runtime structure, major modules, and execution flow.
- [CLI usage](./cli/usage.md) — commands, options, model/provider selection, and credential bootstrap.
- [Agent workflow](./agent/workflow.md) — how documentation runs are assembled and persisted.
- [Credentials and updates](./operations/credentials-and-updates.md) — local env storage, metadata, and scheduled updates.
- [Connectors](./integrations/connectors.md) — built-in connector architecture, the nine connectors (including the generic Custom MCP source), and ingestion orchestration.
- [DeepSWE evaluation harness](./evals/deepswe-harness.md) — paired DeepSWE benchmark harness that measures OpenWiki's documentation leverage on Codex.
- [LEDGER longitudinal benchmark](./evals/ledger-harness.md) — source-grounded benchmark that replays Git checkpoints, runs OpenWiki at each, and scores per-claim grounding and forgetting.

## Key source files

- `README.md` — user-facing installation and usage summary.
- `package.json` — bin entrypoint, scripts, and dependencies.
- `src/cli/cli.tsx` — process entrypoint: parses argv, loads env, and dispatches to the interactive app, print runner, or operational subcommands.
- `src/cli/app/app.tsx` — Ink interactive app shell: chat, run lifecycle, provider/model selection, and streaming.
- `src/cli/commands.ts` — CLI parsing and help content.
- `src/cli/runners.ts` — non-interactive runners for auth, ngrok, cron, ingest, visualize, and print commands.
- `src/cli/diagnostics/` — `error-diagnostics.ts`, `sanitize.ts`, and `auth-fix.ts` for the `--debug` diagnostics panel and auth-failure fix guidance.
- `src/agent/index.ts` — agent runtime, provider-specific model creation (including ChatGPT OAuth), OpenAI model-availability pre-check, fallback, and metadata writes.
- `src/agent/prompt.ts` — prompt assembler: selects a template by output mode and substitutes placeholders.
- `src/agent/prompts/code.ts` — `CODE_SYSTEM_PROMPTS`/`CODE_USER_PROMPTS` for repository runs (init/update/chat contracts, including the skeleton-critic and wiki-QA verification workflow).
- `src/agent/prompts/personal.ts` — `PERSONAL_SYSTEM_PROMPTS`/`PERSONAL_USER_PROMPTS` for local personal-brain runs.
- `src/agent/skeleton_critic.ts` — `skeleton_critic` init-only subagent that reviews the proposed wiki skeleton against the repository.
- `src/agent/wiki_qa_subagents.ts` — `wiki_question_finder` and `wiki_answer_verifier` init-only subagents that verify the completed wiki answers source-grounded questions.
- `src/agent/crash-guard.ts` — process-wide `installCrashGuard()` + `registerActiveRun`/`handleFatal` that records and stamps an escaped rejection as an interrupted run; `handleFatal` claims the active run synchronously so a burst of escaped rejections records one crash.
- `src/agent/utils.ts` — run context, content snapshot, and `.last-update.json` handling.
- `src/agent/types.ts` — shared agent types (`OpenWikiCommand`, `RunContext`, `UpdateMetadata`, run options/events).
- `src/agent/docs-only-backend.ts` — `OpenWikiLocalShellBackend`, extends DeepAgents `LocalShellBackend` with docs-only write guards and output-mode awareness.
- `src/agent/openai-chatgpt-oauth.ts` — ChatGPT OAuth flow, token persistence, and refresh logic for the `openai-chatgpt` provider.
- `src/auth/oauth.ts` — generic OAuth runner for connector providers (Gmail, Notion, Slack, X).
- `src/auth/oauth-discovery.ts` — OAuth endpoint validation and protected-resource metadata discovery for connector OAuth flows.
- `src/auth/providers.ts` — connector OAuth provider configs (scopes, token URLs, env-key mappings).
- `src/auth/configure.ts` — `openwiki auth configure <provider>` flow for creating local connector configs.
- `src/auth/ngrok.ts` — Slack HTTPS callback tunnel via ngrok.
- `src/auth/tokens.ts` — token refresh and validation helpers for connector OAuth.
- `src/agent/okf-middleware.ts` — OKF front-matter migration and index synchronization middleware; its finalize stage also validates Mermaid fences and internal wiki links.
- `src/agent/wiki-link-validator.ts` — validates internal links repo-wide (not just the `openwiki/` subtree) and GitHub-style heading anchors on Markdown targets after generation, stamping broken links inline instead of failing the run.
- `src/agent/translation-middleware.ts` — wiki translation middleware for output-language switching.
- `src/agent/vertex-surface.ts` — Vertex AI model routing for the gemini-enterprise provider.
- `src/agent/skills.ts` — bundles and syncs the `/skills/` directory into the agent runtime.
- `src/auth/external-cli-auth.ts` — GitHub CLI-based credential resolution for the copilot provider.
- `src/platform/diagnostics.ts` — secret redaction and credential diagnostics.
- `src/okf/` — OKF front-matter validation, index-label localization, and deterministic index synchronization.
- `src/mermaid/` — Mermaid fence extraction, validation, and wiki repair.
- `src/telemetry/` — anonymous usage telemetry with PostHog, opt-out, CI sentinel IDs, error classification/fingerprinting, and a baked-in `build_channel` stamp.
- `scripts/stamp-build-channel.cjs` — release-only build-time rewrite of `BUILD_CHANNEL` in `src/telemetry/gates.ts` from `"community"` to `"official"` for npm-published upstream builds, driven by `OPENWIKI_BUILD_CHANNEL` in `.github/workflows/release.yml`.
- `src/connectors/` — connector registry, MCP client/runtime, source-specific ingestion (git-repo, gmail, hackernews, langsmith, slack, web-search, x), and tool definitions.
- `src/ingestion/ingestion.ts` — orchestrates source ingestion runs across configured connectors.
- `src/ingestion/code-mode.ts` — `openwiki code` setup: creates the GitHub Actions workflow only when missing (preserving customizations on update) and refreshes AGENTS.md (full instructions) and CLAUDE.md (a pointer to AGENTS.md) snippets.
- `src/config/env.ts` — `~/.openwiki/.env` persistence and credential diagnostics.
- `src/setup/credentials.tsx` — interactive onboarding flow entrypoint (thin re-export over `src/setup/credentials/` modules: `steps.ts`, `view.tsx`, `use-init-setup.ts`, `persistence.ts`, `format.ts`, `constants.ts`, `types.ts`).
- `src/config/constants.ts` — provider configs, model options, env keys, and validation helpers (including `resolveOpenRouterMaxTokens` and `resolveOpenAiCompatibleUseResponsesApi`).
- `src/model-availability.ts` — `getSelectedModelAvailability()` validates the selected model against the OpenAI `/models` catalogue before inference; `unavailable` aborts, `unknown` proceeds.
- `examples/openwiki-update.yml` — GitHub Actions scheduled automation example.
- `examples/openwiki-update.gitlab-ci.yml` — GitLab CI scheduled automation example.
- `examples/openwiki-update.bitbucket-pipelines.yml` — Bitbucket Pipelines scheduled automation example.
- `evals/deepswe/run.py` — paired DeepSWE evaluation harness entrypoint (see [DeepSWE evaluation harness](./evals/deepswe-harness.md)).
- `evals/ledger/run.ts` — LEDGER longitudinal benchmark entrypoint: loads a benchmark, replays its Git checkpoints through the OpenWiki system adapter, and evaluates each frozen wiki snapshot (see [LEDGER longitudinal benchmark](./evals/ledger-harness.md)).
- `evals/ledger/reevaluate.ts` — re-evaluates a completed LEDGER run without re-invoking OpenWiki.
- `evals/ledger/system/openwiki-system.ts` — `OpenWikiSystem` adapter that drives `runOpenWikiAgent` (`init`/`update`, `outputMode: "repository"`) against each replayed checkpoint.
- `src/visualize/server.ts` — local loopback HTTP server for `openwiki visualize` (node graph + live reader, SSE reload).
- `src/visualize/graph.ts` — parses the wiki into concept nodes and Markdown-link edges for the visualizer.
- `src/visualize/page.ts` — branded single-page visualizer app HTML served at `/`.
- `src/agent/openwiki-ignore.ts` — `.openwikiignore` parsing and gitignore-compatible matching (read boundary for doc runs).
- `src/platform/language.ts` — `resolveLanguage()` BCP-47 validation/canonicalization for `--language`.

## Documentation map

- [Architecture](./architecture/overview.md)
- [CLI](./cli/usage.md)
- [Agent](./agent/workflow.md)
- [Operations](./operations/credentials-and-updates.md)
- [Connectors](./integrations/connectors.md)
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
- `src/cli/diagnostics/` (`error-diagnostics.ts`, `sanitize.ts`, `auth-fix.ts`)
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
- `src/auth/external-cli-auth.ts`
- `src/platform/diagnostics.ts`
- `src/platform/utils.ts`
- `src/platform/language.ts`
- `src/okf/` (frontmatter.ts, index-labels.ts, index-sync.ts)
- `src/mermaid/` (dom-shim.ts, fences.ts, validate.ts, wiki.ts)
- `src/telemetry/`
- `scripts/stamp-build-channel.cjs`
- `examples/openwiki-update.yml`
- `examples/openwiki-update.gitlab-ci.yml`
- `examples/openwiki-update.bitbucket-pipelines.yml`
- `src/visualize/` (server.ts, graph.ts, page.ts, client.ts, client-lib.ts)
- `src/agent/openwiki-ignore.ts`
- `src/scheduling/schedules.ts`
