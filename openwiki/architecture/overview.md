# Architecture overview

OpenWiki has a small but layered architecture:

1. `src/cli.tsx` provides the interactive terminal application and orchestrates runs.
2. `src/commands.ts` parses argv and defines help text and supported options.
3. `src/credentials.tsx` manages interactive onboarding for the OpenRouter key, model selection, and optional LangSmith tracing.
4. `src/env.ts` reads and writes `~/.openwiki/.env` and surfaces credential diagnostics.
5. `src/agent/index.ts` runs the documentation agent, collects Git context, and writes update metadata.
6. `src/agent/prompt.ts` builds the system and user prompts that tell the model how to behave.
7. `src/agent/utils.ts` gathers Git evidence and records `.last-update.json` after successful init/update runs.
8. `src/constants.ts` centralizes environment keys, default model IDs, and the wiki directory names.

## Runtime shape

The CLI starts in `src/cli.tsx`, parses the command, and then either:

- prints help and exits,
- opens the interactive chat UI,
- runs an init/update command against the current repository, or
- performs a dry-run in development mode.

For non-chat runs, the agent receives a `RunContext` that includes last-update metadata and a Git summary generated from:

- `git status --short`
- `git rev-parse HEAD`
- `git log --max-count=20 --name-status --oneline`
- `git diff --name-status HEAD`
- a change window since the previous successful OpenWiki update when metadata exists

The agent then uses a DeepAgents `LocalShellBackend` rooted at the repository, configured with `virtualMode: true`, `maxOutputBytes: 100_000`, `rootDir` set to the repository working directory, and a 120 second timeout.

A SQLite checkpointer (`SqliteSaver` from `@langchain/langgraph-checkpoint-sqlite`) persists conversation threads at `~/.openwiki/openwiki.sqlite`. The checkpoint file is set to `0o600` permissions after each run. Thread IDs are derived from the repository path plus a random run ID, allowing follow-up messages within the same session to reuse conversation state.

## Content snapshot and metadata gating

After a non-chat run completes, the agent does not unconditionally write `.last-update.json`. Instead, `src/agent/utils.ts` computes a SHA-256 hash of all files in `openwiki/` (excluding `.last-update.json` itself) before and after the run. Metadata is written only when the content hash changed. If the agent made no modifications to the wiki, the metadata file is left untouched and the run is logged as `metadata=skipped openwiki=unchanged`.

## Why the architecture is shaped this way

The current design reflects a documentation product rather than a general-purpose agent framework:

- The CLI owns user experience and credential bootstrap so the tool is install-and-run friendly.
- Git evidence is collected in the host process before the agent starts so the model sees stable repository context.
- Update metadata is written only after successful non-chat runs, which lets later updates diff from the last known good state.
- Model fallback is handled in the agent runtime, allowing OpenWiki to retry across a small set of models when OpenRouter returns server-side errors. The default model is `z-ai/glm-5.2` (defined in `src/constants.ts`); fallback models are `openai/gpt-5.4-mini` and `anthropic/claude-sonnet-4-6`.

## Agent-instruction file management

The system prompt (`src/agent/prompt.ts`) instructs the agent to create or update a top-level `/AGENTS.md` (and `/CLAUDE.md` if it exists) with an OpenWiki reference section on every init/update run. This section links to `openwiki/quickstart.md` and tells coding agents to read the wiki first. This is the only source-code modification the agent is allowed to make outside `openwiki/`.

## Major extension points

- Add or refine CLI commands in `src/commands.ts` and the corresponding UI behavior in `src/cli.tsx`.
- Change onboarding or local credential storage in `src/credentials.tsx` and `src/env.ts`.
- Adjust model defaults or validation in `src/constants.ts`.
- Extend the documentation prompt or Git evidence in `src/agent/prompt.ts` and `src/agent/utils.ts`.
- Modify run persistence behavior in `src/agent/utils.ts`.

## Things to watch when editing

- `src/cli.tsx` and `src/commands.ts` must stay aligned; help text and parser behavior are intentionally coupled.
- Credential setup writes to a real home-directory file, so permission handling matters.
- The agent is expected to work from repository-local virtual paths like `/README.md` and `/openwiki/quickstart.md`; the prompt explicitly warns about this.
- `openwiki/` in the target repository is both the docs output location and the metadata location for `.last-update.json`.

## Source map

- `src/cli.tsx`
- `src/commands.ts`
- `src/credentials.tsx`
- `src/env.ts`
- `src/agent/index.ts`
- `src/agent/prompt.ts`
- `src/agent/utils.ts`
- `src/agent/types.ts`
- `src/constants.ts`
- `package.json`
- Git evidence: commit `405ea96` (initial commit, single-commit repo)
