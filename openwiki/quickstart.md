---
type: Quickstart Guide
title: OpenWiki Quickstart
description: Quickstart reference for the OpenWiki TypeScript CLI, including documentation-generation workflows, supported model providers, and the primary source files. Use it to navigate the repository's architecture, commands, agent runtime, operations, and connectors.
tags: [openwiki, quickstart, cli, documentation]
---

# OpenWiki quickstart

OpenWiki is a TypeScript CLI that writes and maintains documentation for a repository using an agent-driven workflow. The package exposes a single `openwiki` binary, stores local credentials in `~/.openwiki/.env`, and records successful update metadata in `openwiki/.last-update.json`.

## What this repository does

- Launches an interactive Ink-based terminal app for chatting with the OpenWiki agent.
- Supports one-shot documentation runs with `--init`, `--update`, and `--print`.
- Supports multiple model providers — OpenAI (default, API key or ChatGPT OAuth login), GitHub Copilot (via GitHub CLI), OpenRouter, Anthropic, Gemini (AI Studio), Gemini Enterprise (Vertex AI, keyless via Google ADC), AWS Bedrock, Nebius Token Factory, Baseten, Fireworks, NVIDIA NIM, and any OpenAI-compatible gateway — each with their own credentials and model list (Gemini Enterprise uses Google ADC instead of an API key; Bedrock uses AWS access/secret keys and region; Copilot uses the GitHub CLI for auth).
- Uses a DeepAgents local shell backend with virtual filesystem paths rooted at the target repository.
- Creates or refreshes documentation under the target repository's `openwiki/` directory.
- Auto-exits after successful `--init` or `--update` runs in an interactive terminal, so the CLI works as both a one-shot and interactive tool.
- Optionally schedules automated updates through GitHub Actions, GitLab CI, or Bitbucket Pipelines.
- Ships a paired DeepSWE evaluation harness (`evals/deepswe/`) that measures OpenWiki's documentation leverage on a Codex coding agent.
- Serves an interactive node-graph visualizer (`openwiki visualize`) for an already-generated wiki, with live edits refreshed over SSE.
- Honors a repo-root `.openwikiignore` file as a read boundary that keeps private/generated paths out of doc runs.
- Generates the wiki in a non-English language with `--language <locale>` (BCP-47); the language is persisted and retranslated on a switch via the translation middleware.
- Stamps a `build_channel` (`official` / `community`) into each telemetry event at build time so fork-originated telemetry can be filtered from the official-release signal.

## Start here

- [Architecture overview](./architecture/overview.md) — runtime structure, major modules, and execution flow.
- [CLI usage](./cli/usage.md) — commands, options, model/provider selection, and credential bootstrap.
- [Agent workflow](./agent/workflow.md) — how documentation runs are assembled and persisted.
- [Credentials and updates](./operations/credentials-and-updates.md) — local env storage, metadata, and scheduled updates.
- [Connectors](./integrations/connectors.md) — built-in connector architecture, the eight connectors, and ingestion orchestration.
- [DeepSWE evaluation harness](./evals/deepswe-harness.md) — paired DeepSWE benchmark harness that measures OpenWiki's documentation leverage on Codex.

## Key source files

- `README.md` — user-facing installation and usage summary.
- `package.json` — bin entrypoint (`./dist/cli/cli.js`), scripts (including a `postbuild` chmod that preserves the exec bit on the linked binary), and dependencies.
- `src/cli/cli.tsx` — CLI entrypoint: loads env, parses the command, installs the crash guard, and dispatches to the Ink `App` or the non-interactive runners.
- `src/cli/app/app.tsx` — Ink `App` component owning the interactive chat UI, init/update launch, streaming render, and run lifecycle.
- `src/cli/app/run-state.ts` — `RunState` finite lifecycle (idle / streaming / settled / failed / setup-complete-exit) carried by the App.
- `src/cli/runners.ts` — non-interactive command runners (`runPrintCommand`, `runAuthCommand`, `runCronCommand`, `runIngestCommand`, `runNgrokCommand`, `runVisualizeCommand`) and print-mode error/auth-fix rendering.
- `src/cli/run-mode.ts` — `shouldAutoExitStartupRun()`, `argvRequestsPrint()`, `shouldPrintStartupError()`, and run-mode cwd/output-mode resolution.
- `src/cli/commands.ts` — CLI parsing, help content, and supported options/subcommands.
- `src/cli/components/` — Ink presentational components (`chat`, `header`, `panels`, `run-view`, `markdown`, `primitives`, `first-run-notice`).
- `src/cli/input/` — input helpers (`cursor`, `menu` arrow-key selection, `secret`).
- `src/cli/run-log/` — run-log reducer and tool-display formatting for the streaming log view.
- `src/cli/diagnostics/` — `sanitize` (header/control-char scrubbing), `auth-fix` (provider auth remediation hints), and `error-diagnostics` (allowlisted error detail rendering).
- `src/cli/format.ts` — display formatting helpers (cwd, model id, spinner, log truncation).
- `src/cli/guards.ts` — small runtime type guards.
- `src/cli/debug.ts` — `OPENWIKI_DEBUG` and credential-diagnostic visibility gates.
- `src/cli/schedule-format.ts` — cron/schedule formatting for the `cron list` view.
- `src/cli/startup.ts` — startup command resolution (TTY/non-TTY mode selection).
- `src/agent/index.ts` — agent runtime, provider-specific model creation (including ChatGPT OAuth), fallback, and metadata writes.
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
- `src/auth/oauth-discovery.ts` — OAuth 2.0 protected-resource/authorization-server metadata discovery and endpoint validation.
- `src/auth/providers.ts` — connector OAuth provider configs (scopes, token URLs, env-key mappings).
- `src/auth/configure.ts` — `openwiki auth configure <provider>` flow for creating local connector configs.
- `src/auth/ngrok.ts` — Slack HTTPS callback tunnel via ngrok.
- `src/auth/tokens.ts` — token refresh and validation helpers for connector OAuth.
- `src/auth/external-cli-auth.ts` — GitHub CLI-based credential resolution for the copilot provider.
- `src/agent/okf-middleware.ts` — OKF front-matter migration and index synchronization middleware; its finalize stage also validates Mermaid fences and internal wiki links.
- `src/agent/wiki-link-validator.ts` — validates internal links repo-wide (not just the `openwiki/` subtree) and GitHub-style heading anchors on Markdown targets after generation, stamping broken links inline instead of failing the run.
- `src/agent/translation-middleware.ts` — wiki translation middleware for output-language switching.
- `src/agent/vertex-surface.ts` — Vertex AI model routing for the gemini-enterprise provider.
- `src/agent/skills.ts` — bundles and syncs the `/skills/` directory into the agent runtime.
- `src/platform/diagnostics.ts` — secret redaction (`sanitizeDiagnosticText`) and credential diagnostics.
- `src/okf/` — OKF front-matter validation, index-label localization, and deterministic index synchronization.
- `src/mermaid/` — Mermaid fence extraction, validation, and wiki repair.
- `src/telemetry/` — anonymous usage telemetry with PostHog, opt-out, CI sentinel IDs, error classification/fingerprinting, and a baked-in `build_channel` stamp.
- `scripts/stamp-build-channel.cjs` — release-only build-time rewrite of `BUILD_CHANNEL` in `src/telemetry/gates.ts` from `"community"` to `"official"` for npm-published upstream builds, driven by `OPENWIKI_BUILD_CHANNEL` in `.github/workflows/release.yml`.
- `src/connectors/` — connector registry, MCP client/runtime, source-specific ingestion (git-repo, gmail, hackernews, langsmith, slack, web-search, x), connector config parsing (`config.ts`), and tool definitions.
- `src/ingestion/ingestion.ts` — orchestrates source ingestion runs across configured connectors.
- `src/ingestion/code-mode.ts` — `openwiki code` setup: creates the GitHub Actions workflow only when missing (preserving customizations on update) and refreshes AGENTS.md/CLAUDE.md snippets.
- `src/config/env.ts` — `~/.openwiki/.env` persistence and credential diagnostics.
- `src/setup/credentials.tsx` — thin composition root for the interactive onboarding flow; delegates to `src/setup/credentials/` modules (`steps.ts`, `use-init-setup.ts`, `view.tsx`, `persistence.ts`, `format.ts`, `constants.ts`).
- `src/config/constants.ts` — provider configs, model options, env keys, and validation helpers.
- `examples/openwiki-update.yml` — GitHub Actions scheduled automation example.
- `examples/openwiki-update.gitlab-ci.yml` — GitLab CI scheduled automation example.
- `examples/openwiki-update.bitbucket-pipelines.yml` — Bitbucket Pipelines scheduled automation example.
- `evals/deepswe/run.py` — paired DeepSWE evaluation harness entrypoint (see [DeepSWE evaluation harness](./evals/deepswe-harness.md)).
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

## Notes for future agents

- The repository is intentionally focused: the main product surface is the CLI plus the documentation-generation agent.
- Treat `openwiki/` in this repo as generated documentation output from a future OpenWiki run, not as application source.
- The CLI is organized under `src/cli/`: `cli.tsx` is the entrypoint, `app/app.tsx` is the interactive Ink app, `runners.ts` holds the non-interactive command runners, `commands.ts` parses argv, and `run-mode.ts` owns auto-exit/print-mode decisions. User-visible semantics are split across `src/cli/commands.ts`, `src/cli/app/app.tsx`, and `src/agent/*`.
- Provider support is centralized in `src/config/constants.ts`. Adding or changing a provider means updating `PROVIDER_CONFIGS`, the `OpenWikiProvider` type, the `SELECTABLE_OPENWIKI_PROVIDERS` list, and the model-creation branch in `src/agent/index.ts`. OAuth-based providers also need an entry in `src/auth/` if they use browser-login flows. Providers without an API key (like `gemini-enterprise`) declare their required env keys (e.g. `projectEnvKey`) in `PROVIDER_CONFIGS` and are gated by `getMissingProviderEnvKey()` instead. External-CLI-auth providers (like `copilot`) declare `authMethod: "external-cli"` and an `externalCliAuthAdapter`, with the login flow handled in `src/auth/external-cli-auth.ts`. AWS SDK providers (like `bedrock`) declare `authMethod: "aws-sdk"` and delegate credential resolution to the AWS SDK chain.

## Source map

- `README.md`
- `package.json`
- `src/cli/cli.tsx`
- `src/cli/app/app.tsx`
- `src/cli/app/run-state.ts`
- `src/cli/runners.ts`
- `src/cli/run-mode.ts`
- `src/cli/commands.ts`
- `src/cli/components/` (chat, first-run-notice, header, markdown, panels, primitives, run-view, types)
- `src/cli/input/` (cursor, menu, secret, types)
- `src/cli/run-log/` (reducer, tool-display, types)
- `src/cli/diagnostics/` (auth-fix, error-diagnostics, sanitize)
- `src/cli/format.ts`, `src/cli/guards.ts`, `src/cli/debug.ts`, `src/cli/schedule-format.ts`, `src/cli/startup.ts`
- `src/agent/index.ts`
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
- `src/connectors/config.ts`
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
- `src/setup/credentials.tsx`
- `src/setup/credentials/` (components.tsx, constants.ts, format.ts, persistence.ts, steps.ts, types.ts, use-init-setup.ts, view.tsx)
- `src/config/constants.ts`
- `src/auth/external-cli-auth.ts`
- `src/platform/diagnostics.ts`
- `src/okf/` (frontmatter.ts, index-labels.ts, index-sync.ts)
- `src/mermaid/` (dom-shim.ts, fences.ts, validate.ts, wiki.ts)
- `src/telemetry/`
- `scripts/stamp-build-channel.cjs`
- `examples/openwiki-update.yml`
- `examples/openwiki-update.gitlab-ci.yml`
- `examples/openwiki-update.bitbucket-pipelines.yml`
- `src/visualize/` (server.ts, graph.ts, page.ts, client.ts, client-lib.ts)
- `src/agent/openwiki-ignore.ts`
- `src/platform/language.ts`
