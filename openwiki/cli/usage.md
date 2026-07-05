# CLI usage

OpenWiki ships as a single `openwiki` binary and is intended to work both as an interactive terminal app and as a one-shot documentation runner.

## Commands and modes

From `src/commands.ts` and `README.md`, the supported entry patterns are:

- `openwiki` — open the interactive chat UI.
- `openwiki "message"` — send a chat message immediately, then stay open.
- `openwiki --init [message]` — generate initial OpenWiki documentation.
- `openwiki --update [message]` — refresh existing OpenWiki documentation.
- `openwiki -p, --print` — run once and print the final assistant output (non-interactive).
- `openwiki --modelId <id>` / `--model-id <id>` — choose a model ID for the run.
- `openwiki --help` / `-h` — print usage, options, and examples.
- `openwiki --dry-run` — development-only option that avoids invoking the agent.

The parser rejects incompatible combinations such as `--init` and `--update` together, and it requires a message or command when `--print` is used.

### Auto-exit for init/update

When `--init` or `--update` is run in a TTY (without `--print`), the CLI starts the run, streams agent output, and **exits automatically on success** (`shouldAutoExitStartupRun` in `src/cli.tsx`). This means `openwiki --init` behaves like a one-shot command while still showing a live UI. Chat runs and `--print` runs are not affected — chat stays open for follow-ups, and `--print` writes to stdout and exits.

### Non-interactive mode

If stdin is not a TTY (e.g. CI), or `--print` is used, the CLI requires a provider API key to be already saved in `~/.openwiki/.env` or present in the environment. It will error with a clear message if the key is missing, rather than prompting interactively.

## Interactive behavior

`src/cli.tsx` is the Ink-based app shell. It handles:

- chat submission and follow-up messages,
- `init` / `update` command launches (including from `/init` and `/update` slash commands),
- provider and model selection during the session (`/provider`, `/model`),
- interactive credential setup when required (including for init/update, not just chat),
- streaming agent text and tool events,
- completed-run history and error display,
- exit handling for help, errors, and explicit `/exit` messages.

The UI persists provider and model selection back to `~/.openwiki/.env` through `saveOpenWikiEnv()`.

## Credentials and onboarding

The first interactive run can prompt for:

- a **provider** (`OPENWIKI_PROVIDER`) — openrouter, baseten, fireworks, openai, or anthropic,
- the **provider API key** (e.g. `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `BASETEN_API_KEY`, `FIREWORKS_API_KEY`),
- a **model ID** stored as `OPENWIKI_MODEL_ID` — chosen from the provider's model list or a custom ID,
- optional `LANGSMITH_API_KEY` for tracing.

If a LangSmith key is provided, onboarding also enables `LANGCHAIN_PROJECT=openwiki` and `LANGCHAIN_TRACING_V2=true`.

`src/credentials.tsx` determines whether setup is needed and walks the user through the missing values using arrow-key selection menus for provider and model. See [Credentials and updates](../operations/credentials-and-updates.md) for details.

## Provider and model selection

Providers and their model options are defined in `PROVIDER_CONFIGS` in `src/constants.ts`:

| Provider   | Env key              | Base URL                                | Models                                                                |
| ---------- | -------------------- | --------------------------------------- | --------------------------------------------------------------------- |
| openrouter | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1`          | GLM 5.2, Fusion, Kimi K2.7 Code, Claude Opus/Sonnet, GPT 5.4 mini/5.5 |
| baseten    | `BASETEN_API_KEY`    | `https://inference.baseten.co/v1`       | GLM 5.2, Kimi K2.7 Code                                               |
| fireworks  | `FIREWORKS_API_KEY`  | `https://api.fireworks.ai/inference/v1` | GLM 5.2, Kimi K2.7 Code                                               |
| openai     | `OPENAI_API_KEY`     | (default)                               | GPT 5.4 mini, GPT 5.5                                                 |
| anthropic  | `ANTHROPIC_API_KEY`  | (default)                               | Haiku, Sonnet, Opus                                                   |

The default provider is `openrouter`. `resolveConfiguredProvider()` picks the provider from `OPENWIKI_PROVIDER`, falling back to openrouter if `OPENROUTER_API_KEY` is set, then to `DEFAULT_PROVIDER`.

## Help text and validation

The help content is centralized in `src/commands.ts` and is used by the CLI UI. Model validation is intentionally strict:

- model IDs are trimmed,
- they must match the allowed character pattern (`/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u`),
- URLs are rejected,
- fallback models for OpenRouter are defined in `OPENROUTER_FALLBACK_MODEL_IDS` in `src/constants.ts`.

## What to change when editing the CLI

- Update parser behavior in `src/commands.ts` first.
- Then update any user-visible text in `src/cli.tsx` and `README.md`.
- If new options affect run behavior, make sure `src/agent/index.ts` and `src/credentials.tsx` still receive the right inputs.
- If adding a provider, update `PROVIDER_CONFIGS` and `SELECTABLE_OPENWIKI_PROVIDERS` in `src/constants.ts`, `managedEnvKeys` in `src/env.ts`, and the `createModel` branch in `src/agent/index.ts`.
- Re-check the `package.json` bin entry and scripts if the entrypoint changes.

## Source map

- `src/cli.tsx`
- `src/commands.ts`
- `src/credentials.tsx`
- `src/constants.ts`
- `src/env.ts`
- `README.md`
- `package.json`
- Git evidence: commits `ceded10`, `f89b05d`, `fd3a702`, `8278c36`, `0fa1430`
