# CLI usage

OpenWiki ships as a single `openwiki` binary and is intended to work both as an interactive terminal app and as a one-shot documentation runner.

## Commands and modes

From `src/commands.ts` and `README.md`, the supported entry patterns are:

- `openwiki` — open the interactive chat UI.
- `openwiki "message"` — send a chat message immediately, then stay open.
- `openwiki --init [message]` — generate initial OpenWiki documentation.
- `openwiki --update [message]` — refresh existing OpenWiki documentation.
- `openwiki -p, --print` — run once and print the final assistant output.
- `openwiki --modelId <id>` / `--model-id <id>` — choose an OpenRouter model for the run.
- `openwiki --dry-run` — development-only option that avoids invoking the agent.

The parser rejects incompatible combinations such as `--init` and `--update` together, and it requires a message or command when `--print` is used.

## Interactive behavior

`src/cli.tsx` is the Ink-based app shell. It handles:

- chat submission and follow-up messages,
- `init` / `update` command launches,
- model selection during the session via the `/model` command (presents suggested models from `src/constants.ts` or accepts a custom model ID),
- interactive credential setup when required,
- streaming agent text and tool events,
- completed-run history and error display,
- exit handling for help, errors, and explicit exit messages.

The UI persists model selection back to `~/.openwiki/.env` through `saveOpenWikiEnv()`.

## Credentials and onboarding

The first run can prompt for:

- `OPENROUTER_API_KEY`
- a model ID stored as `OPENWIKI_MODEL_ID` (defaults to `z-ai/glm-5.2` from `src/constants.ts` if unset)
- optional `LANGSMITH_API_KEY`

If a LangSmith key is provided, onboarding also enables `LANGCHAIN_PROJECT=openwiki` and `LANGCHAIN_TRACING_V2=true`.

`src/credentials.tsx` determines whether setup is needed and walks the user through the missing values. During an interactive session, the `/model` command lets users switch models or enter a custom OpenRouter model ID; the choice is persisted to `~/.openwiki/.env`.

## Help text and validation

The help content is centralized in `src/commands.ts` and is used by the CLI UI. Model validation is intentionally strict:

- model IDs are trimmed,
- they must match the allowed character pattern,
- URLs are rejected,
- fallback models are defined in `src/constants.ts`.

## What to change when editing the CLI

- Update parser behavior in `src/commands.ts` first.
- Then update any user-visible text in `src/cli.tsx` and `README.md`.
- If new options affect run behavior, make sure `src/agent/index.ts` and `src/credentials.tsx` still receive the right inputs.
- Re-check the `package.json` bin entry and scripts if the entrypoint changes.

## Development workflow

`DEVELOPMENT.md` covers local development setup: install with `pnpm install`, build with `pnpm run build`, link globally with `pnpm link --global`, and run a dry test from a target repo with `OPENWIKI_DEV=1 openwiki --dry-run`. The `examples/openwiki-update.yml` file provides a copyable GitHub Actions workflow for scheduling automated updates in external repositories.

## Source map

- `src/cli.tsx`
- `src/commands.ts`
- `src/credentials.tsx`
- `src/constants.ts`
- `README.md`
- `DEVELOPMENT.md`
- `package.json`
- `examples/openwiki-update.yml`
- Git evidence: commit `405ea96` (initial commit, single-commit repo)
