# OpenWiki quickstart

OpenWiki is a TypeScript CLI that writes and maintains documentation for a repository using an agent-driven workflow. The package exposes a single `openwiki` binary, stores local credentials in `~/.openwiki/.env`, and records successful update metadata in `openwiki/.last-update.json`.

## What this repository does

- Launches an interactive Ink-based terminal app for chatting with the OpenWiki agent.
- Supports one-shot documentation runs with `--init`, `--update`, and `--print`.
- Supports multiple model providers — OpenAI (default, API key or ChatGPT OAuth login), OpenRouter, Anthropic, Baseten, Fireworks, NVIDIA NIM, and any OpenAI-compatible gateway — each with their own API key and model list.
- Uses a DeepAgents local shell backend with virtual filesystem paths rooted at the target repository.
- Creates or refreshes documentation under the target repository's `openwiki/` directory.
- Auto-exits after successful `--init` or `--update` runs in an interactive terminal, so the CLI works as both a one-shot and interactive tool.
- Optionally schedules automated updates through GitHub Actions, GitLab CI, or Bitbucket Pipelines.

## Start here

- [Architecture overview](./architecture/overview.md) — runtime structure, major modules, and execution flow.
- [CLI usage](./cli/usage.md) — commands, options, model/provider selection, and credential bootstrap.
- [Agent workflow](./agent/workflow.md) — how documentation runs are assembled and persisted.
- [Credentials and updates](./operations/credentials-and-updates.md) — local env storage, metadata, and scheduled updates.
- [Connectors](./integrations/connectors.md) — built-in connector architecture, the seven connectors, and ingestion orchestration.

## Key source files

- `README.md` — user-facing installation and usage summary.
- `package.json` — bin entrypoint, scripts, and dependencies.
- `src/cli.tsx` — Ink UI, command execution, auto-exit, and run lifecycle.
- `src/commands.ts` — CLI parsing and help content.
- `src/agent/index.ts` — agent runtime, provider-specific model creation (including ChatGPT OAuth), fallback, and metadata writes.
- `src/agent/prompt.ts` — prompt assembly, documentation-run instructions, and AGENTS.md/CLAUDE.md insertion rules.
- `src/agent/utils.ts` — git evidence collection, content snapshot, and `.last-update.json` handling.
- `src/agent/types.ts` — shared agent types (`OpenWikiCommand`, `RunContext`, `UpdateMetadata`, run options/events).
- `src/agent/docs-only-backend.ts` — `OpenWikiLocalShellBackend`, extends DeepAgents `LocalShellBackend` with docs-only write guards and output-mode awareness.
- `src/agent/openai-chatgpt-oauth.ts` — ChatGPT OAuth flow, token persistence, and refresh logic for the `openai-chatgpt` provider.
- `src/auth/oauth.ts` — generic OAuth runner for connector providers (Gmail, Notion, Slack, X).
- `src/auth/providers.ts` — connector OAuth provider configs (scopes, token URLs, env-key mappings).
- `src/auth/configure.ts` — `openwiki auth configure <provider>` flow for creating local connector configs.
- `src/auth/ngrok.ts` — Slack HTTPS callback tunnel via ngrok.
- `src/auth/tokens.ts` — token refresh and validation helpers for connector OAuth.
- `src/connectors/` — connector registry, MCP client/runtime, source-specific ingestion (git-repo, gmail, hackernews, slack, web-search, x), and tool definitions.
- `src/ingestion.ts` — orchestrates source ingestion runs across configured connectors.
- `src/code-mode.ts` — `openwiki code` setup: writes GitHub Actions workflow and AGENTS.md/CLAUDE.md snippets.
- `src/env.ts` — `~/.openwiki/.env` persistence and credential diagnostics.
- `src/credentials.tsx` — interactive onboarding flow for provider selection, API keys, and model selection.
- `src/constants.ts` — provider configs, model options, env keys, and validation helpers.
- `examples/openwiki-update.yml` — GitHub Actions scheduled automation example.
- `examples/openwiki-update.gitlab-ci.yml` — GitLab CI scheduled automation example.
- `examples/openwiki-update.bitbucket-pipelines.yml` — Bitbucket Pipelines scheduled automation example.

## Documentation map

- [Architecture](./architecture/overview.md)
- [CLI](./cli/usage.md)
- [Agent](./agent/workflow.md)
- [Operations](./operations/credentials-and-updates.md)
- [Connectors](./integrations/connectors.md)

## Notes for future agents

- The repository is intentionally focused: the main product surface is the CLI plus the documentation-generation agent.
- Treat `openwiki/` in this repo as generated documentation output from a future OpenWiki run, not as application source.
- When changing behavior, verify both the CLI parser and the agent prompt/runtime, because user-visible semantics are split across `src/commands.ts`, `src/cli.tsx`, and `src/agent/*`.
- Provider support is centralized in `src/constants.ts`. Adding or changing a provider means updating `PROVIDER_CONFIGS`, the `OpenWikiProvider` type, the `SELECTABLE_OPENWIKI_PROVIDERS` list, and the model-creation branch in `src/agent/index.ts`. OAuth-based providers also need an entry in `src/auth/` if they use browser-login flows.

## Source map

- `README.md`
- `package.json`
- `src/cli.tsx`
- `src/commands.ts`
- `src/agent/index.ts`
- `src/agent/prompt.ts`
- `src/agent/utils.ts`
- `src/agent/types.ts`
- `src/agent/docs-only-backend.ts`
- `src/agent/openai-chatgpt-oauth.ts`
- `src/auth/oauth.ts`
- `src/auth/providers.ts`
- `src/auth/configure.ts`
- `src/auth/ngrok.ts`
- `src/auth/tokens.ts`
- `src/auth/types.ts`
- `src/connectors/registry.ts`
- `src/connectors/tools.ts`
- `src/connectors/types.ts`
- `src/connectors/mcp-client.ts`
- `src/connectors/mcp-runtime.ts`
- `src/connectors/io.ts`
- `src/connectors/sources/git-repo.ts`
- `src/connectors/sources/gmail.ts`
- `src/connectors/sources/hackernews.ts`
- `src/connectors/sources/mcp.ts`
- `src/connectors/sources/slack.ts`
- `src/connectors/sources/web-search.ts`
- `src/connectors/sources/x.ts`
- `src/ingestion.ts`
- `src/code-mode.ts`
- `src/env.ts`
- `src/credentials.tsx`
- `src/constants.ts`
- `examples/openwiki-update.yml`
- `examples/openwiki-update.gitlab-ci.yml`
- `examples/openwiki-update.bitbucket-pipelines.yml`
- Git evidence: commits `ceded10`, `f89b05d`, `a82759f`, `dfa73cc`, `fd3a702`, `8278c36`, `0fa1430`
