# OpenWiki quickstart

OpenWiki is a TypeScript CLI that writes and maintains documentation for a repository using an agent-driven workflow. The package exposes a single `openwiki` binary, stores local credentials in `~/.openwiki/.env`, and records successful update metadata in `openwiki/.last-update.json`.

## What this repository does

- Launches an interactive Ink-based terminal app for chatting with the OpenWiki agent.
- Supports one-shot documentation runs with `--init`, `--update`, and `--print`.
- Uses OpenRouter models through `@langchain/openrouter` and a DeepAgents local shell backend.
- Creates or refreshes documentation under the target repository's `openwiki/` directory.
- Optionally schedules automated updates through a GitHub Actions workflow.

## Start here

- [Architecture overview](./architecture/overview.md) — runtime structure, major modules, and execution flow.
- [CLI usage](./cli/usage.md) — commands, options, model selection, and credential bootstrap.
- [Agent workflow](./agent/workflow.md) — how documentation runs are assembled and persisted.
- [Credentials and updates](./operations/credentials-and-updates.md) — local env storage, metadata, and scheduled updates.

## Key source files

- `README.md` — user-facing installation and usage summary.
- `DEVELOPMENT.md` — local development setup, linking the CLI globally, and dry-run instructions.
- `package.json` — bin entrypoint, scripts, and dependencies.
- `src/cli.tsx` — Ink UI, command execution, and run lifecycle.
- `src/commands.ts` — CLI parsing and help content.
- `src/agent/index.ts` — agent runtime, model fallback, and metadata writes.
- `src/agent/prompt.ts` — prompt assembly and documentation-run instructions.
- `src/agent/utils.ts` — git evidence collection, content snapshot, and `.last-update.json` handling.
- `src/agent/types.ts` — shared types (`OpenWikiCommand`, `RunContext`, `UpdateMetadata`, `OpenWikiRunEvent`).
- `src/env.ts` — `~/.openwiki/.env` persistence and credential diagnostics.
- `src/credentials.tsx` — interactive setup flow for API keys and model selection.
- `src/constants.ts` — default model (`z-ai/glm-5.2`), fallback models, env keys, and wiki directory names.
- `.github/workflows/openwiki-update.yml` — scheduled automation in CI.
- `examples/openwiki-update.yml` — copyable scheduled update workflow for external repos.

## Documentation map

- [Architecture](./architecture/overview.md)
- [CLI](./cli/usage.md)
- [Agent](./agent/workflow.md)
- [Operations](./operations/credentials-and-updates.md)

## Notes for future agents

- The repository is intentionally focused: the main product surface is the CLI plus the documentation-generation agent.
- Treat `openwiki/` in this repo as generated documentation output from a future OpenWiki run, not as application source.
- When changing behavior, verify both the CLI parser and the agent prompt/runtime, because user-visible semantics are split across `src/commands.ts`, `src/cli.tsx`, and `src/agent/*`.
- The agent prompt (`src/agent/prompt.ts`) instructs OpenWiki to create or update a top-level `/AGENTS.md` (and `/CLAUDE.md` if present) with an OpenWiki reference section on every init/update run. This is the only source-code modification allowed outside `openwiki/`.
- See `DEVELOPMENT.md` for local development setup including `pnpm link --global` and `OPENWIKI_DEV=1 openwiki --dry-run`.

## Source map

- `README.md`
- `DEVELOPMENT.md`
- `package.json`
- `src/cli.tsx`
- `src/commands.ts`
- `src/agent/index.ts`
- `src/agent/prompt.ts`
- `src/agent/utils.ts`
- `src/agent/types.ts`
- `src/constants.ts`
- `src/env.ts`
- `.github/workflows/openwiki-update.yml`
- `examples/openwiki-update.yml`
- Git evidence: commit `405ea96` (initial commit, single-commit repo)
