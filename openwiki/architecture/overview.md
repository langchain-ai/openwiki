# Architecture overview

OpenWiki has a small but layered architecture:

1. `src/cli.tsx` provides the interactive terminal application and orchestrates runs, including auto-exit for init/update.
2. `src/commands.ts` parses argv and defines help text and supported options.
3. `src/credentials.tsx` manages interactive onboarding for provider selection, API keys, model selection, and optional LangSmith tracing.
4. `src/env.ts` reads and writes `~/.openwiki/.env` and surfaces credential diagnostics for all supported providers.
5. `src/agent/index.ts` runs the documentation agent, resolves the provider, creates the appropriate model client, collects Git context, and writes update metadata.
6. `src/agent/prompt.ts` builds the system and user prompts that tell the model how to behave.
7. `src/agent/utils.ts` gathers Git evidence, computes an OpenWiki content snapshot, and records `.last-update.json` after successful init/update runs.
8. `src/constants.ts` centralizes provider configs, model options, environment keys, validation helpers, and the wiki directory names.
9. `src/agent/types.ts` defines shared types: `OpenWikiCommand`, `RunContext`, `UpdateMetadata`, and run option/event interfaces.

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
2. Otherwise, use the first available provider API key in this order: OpenAI, OpenRouter, Anthropic, Baseten, then Fireworks.
3. Otherwise, fall back to `DEFAULT_PROVIDER` (`openai`) and its default model (`gpt-5.5`).

Model creation branches by provider in `src/agent/index.ts` (`createModel`):

- **anthropic** → `ChatAnthropic` with the Anthropic API key.
- **openrouter** → `ChatOpenRouter` with the selected model ID.
- **openai** → `ChatOpenAI` with `useResponsesApi: true`.
- **baseten / fireworks / openai-compatible** → `ChatOpenAI` with the provider's API key and optional custom `baseURL` from `PROVIDER_CONFIGS`.

### DeepAgents backend

The agent uses a DeepAgents `LocalShellBackend` rooted at the repository, configured with `virtualMode: true`, `maxOutputBytes: 100_000`, and a 120 second timeout. A SQLite checkpointer (`~/.openwiki/openwiki.sqlite`) persists conversation threads keyed by a hash of the repository path.

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
- `src/constants.ts`
- `package.json`
- Git evidence: commits `ceded10`, `f89b05d`, `fd3a702`, `8278c36`, `0fa1430`
