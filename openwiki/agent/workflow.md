# Agent workflow

The documentation agent is implemented in `src/agent/`. It takes a command (`chat`, `init`, or `update`), gathers repository context, builds prompts, runs a DeepAgents session, and records successful update metadata.

## Main flow

`src/agent/index.ts` follows this sequence for non-chat runs:

1. Load `~/.openwiki/.env` into `process.env`.
2. Ensure `OPENROUTER_API_KEY` exists.
3. Resolve the model ID from CLI input, environment variables, or the default (`z-ai/glm-5.2`).
4. Create a run context from Git state and prior update metadata.
5. Build the system prompt and user prompt.
6. Create a SQLite checkpointer at `~/.openwiki/openwiki.sqlite` and a DeepAgents `LocalShellBackend` rooted at the repository.
7. Stream messages and tool events back to the CLI.
8. For `init` and `update`, compute a content snapshot of `openwiki/` and write `openwiki/.last-update.json` only if the content actually changed.

Chat runs skip metadata writes entirely.

## Prompting strategy

`src/agent/prompt.ts` encodes the product rules directly into the system prompt. The agent is instructed to:

- inspect the current codebase and write documentation under `openwiki/`,
- use filesystem discovery tools and git history rather than inventing facts,
- keep the initial wiki focused and navigable,
- document the repository for both humans and future agents,
- respect the repository root as the only project in scope,
- avoid reading secrets or `.env` files,
- use git history for init and update runs,
- respect the temporary plan and update metadata requirements.

The user prompt changes with the command:

- `init` includes the current Git summary and asks for fresh documentation.
- `update` includes last update metadata and a Git change summary.
- `chat` just forwards the user message.

## Git evidence and update metadata

`src/agent/utils.ts` is responsible for the repository evidence that the prompt sees:

- current working tree status,
- current HEAD,
- the most recent 20 commits with changed files,
- a diff summary against HEAD,
- a delta since the last successful update when `.last-update.json` includes a `gitHead` or `updatedAt`.

On successful init/update runs, the agent writes JSON metadata with:

- `updatedAt`
- `command`
- `gitHead`
- `model`

That metadata is later used to scope update runs.

### Content snapshot gating

Metadata is not written unconditionally. Before the agent stream starts, `createOpenWikiContentSnapshot()` in `src/agent/utils.ts` computes a SHA-256 hash of all files under `openwiki/` (excluding `.last-update.json`). After the run completes, the hash is recomputed. If the two hashes match — meaning the agent did not modify any documentation — `.last-update.json` is left untouched and the run is logged as `metadata=skipped openwiki=unchanged`. This prevents no-op update runs from advancing the recorded `gitHead` and losing the change-diff window for the next run.

## Model fallback and retries

The agent runtime includes a small retry strategy:

- the selected model is tried first,
- server-side OpenRouter failures can fall back to `OPENROUTER_FALLBACK_MODEL_IDS` (defined in `src/constants.ts` as `openai/gpt-5.4-mini` and `anthropic/claude-sonnet-4-6`),
- retries keep the same command and repository context but use a modified thread ID (`<threadId>-retry-<attemptIndex>`).

This behavior was added in recent commits to make automated documentation runs more resilient.

## Agent-instruction file management

The system prompt (`src/agent/prompt.ts`) instructs the agent to create or refresh a top-level `/AGENTS.md` (and `/CLAUDE.md` if it exists) with a standardized OpenWiki reference section on every init/update run. The section links to `openwiki/quickstart.md` and tells coding agents to read the wiki before working in the repository. During update runs, the agent inspects any existing OpenWiki reference section and refreshes it if stale. This is the only modification allowed outside `openwiki/`.

## Why this matters

The agent is not just a generic chat wrapper. It is intentionally constrained so it can:

- write repository-local docs without wandering outside the repo,
- preserve continuity across runs via checkpointing and metadata,
- keep updates grounded in Git evidence,
- support both interactive and scheduled maintenance use cases.

## Things to watch when changing agent behavior

- Keep the prompt in sync with the actual filesystem tools and path conventions used by the CLI.
- Be careful with `.last-update.json` semantics, because update runs use it to decide what changed since the previous successful run.
- The content snapshot gates metadata writes: if you change the snapshot logic in `src/agent/utils.ts`, ensure it still excludes `.last-update.json` or metadata will be written on every run.
- Credential loading happens before model resolution; changes there affect both onboarding and agent startup.
- The DeepAgents backend is configured with `virtualMode: true`, which is important for documentation-only behavior.
- The SQLite checkpointer at `~/.openwiki/openwiki.sqlite` persists conversation threads; changing the path or format affects session continuity.

## Source map

- `src/agent/index.ts`
- `src/agent/prompt.ts`
- `src/agent/utils.ts`
- `src/agent/types.ts`
- `src/constants.ts`
- `src/env.ts`
- Git evidence: commit `405ea96` (initial commit, single-commit repo)
