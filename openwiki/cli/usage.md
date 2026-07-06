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

### Update runs on an unchanged repository

`openwiki --update` (without a message) skips the agent run entirely and reports that no repository changes were detected when the repository is unchanged since the last recorded update. See [Agent workflow](../agent/workflow.md) for the exact conditions.

### Non-interactive mode

If stdin is not a TTY (e.g. CI), or `--print` is used, the CLI requires a provider API key to be already saved in `~/.openwiki/.env` or present in the environment. It will error with a clear message if the key is missing, rather than prompting interactively. Agent-CLI providers such as `claude-code` and `ibm-bob` are exempt from this check — they need the vendor CLI installed and logged in instead of an API key.

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

- a **provider** (`OPENWIKI_PROVIDER`) — openrouter, baseten, fireworks, openai, openai-compatible, anthropic, claude-code, or ibm-bob,
- the **provider API key** (e.g. `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `OPENAI_COMPATIBLE_API_KEY`, `ANTHROPIC_API_KEY`, `BASETEN_API_KEY`, `FIREWORKS_API_KEY`),
- a **base URL** for providers that require one (the openai-compatible provider prompts for `OPENAI_COMPATIBLE_BASE_URL`),
- a **model ID** stored as `OPENWIKI_MODEL_ID` — chosen from the provider's model list or a custom ID,
- optional `LANGSMITH_API_KEY` for tracing.

If a LangSmith key is provided, onboarding also enables `LANGCHAIN_PROJECT=openwiki` and `LANGCHAIN_TRACING_V2=true`.

Selecting the **claude-code** provider replaces the API-key step with an install check: the setup verifies the Claude Code CLI is runnable (`claude --version`), then asks only for a model choice (subscription default, sonnet, opus, or haiku). No API key or LangSmith step applies — runs use the existing subscription login. Selecting the **ibm-bob** provider behaves the same way but verifies Bob Shell (`bob --version`) and only offers the subscription default model, since ibm-bob has no other model options.

`src/credentials.tsx` determines whether setup is needed and walks the user through the missing values using arrow-key selection menus for provider and model. See [Credentials and updates](../operations/credentials-and-updates.md) for details.

## Provider and model selection

Providers and their model options are defined in `PROVIDER_CONFIGS` in `src/constants.ts`:

| Provider          | Env key                     | Base URL                                | Models                                                                |
| ----------------- | --------------------------- | --------------------------------------- | --------------------------------------------------------------------- |
| openrouter        | `OPENROUTER_API_KEY`        | `https://openrouter.ai/api/v1`          | GLM 5.2, Fusion, Kimi K2.7 Code, Claude Opus/Sonnet, GPT 5.4 mini/5.5 |
| baseten           | `BASETEN_API_KEY`           | `https://inference.baseten.co/v1`       | GLM 5.2, Kimi K2.7 Code                                               |
| fireworks         | `FIREWORKS_API_KEY`         | `https://api.fireworks.ai/inference/v1` | GLM 5.2, Kimi K2.7 Code                                               |
| openai            | `OPENAI_API_KEY`            | (default)                               | GPT 5.4 mini, GPT 5.5                                                 |
| openai-compatible | `OPENAI_COMPATIBLE_API_KEY` | `OPENAI_COMPATIBLE_BASE_URL` (required) | custom model ID only                                                  |
| anthropic         | `ANTHROPIC_API_KEY`         | (default, or `ANTHROPIC_BASE_URL`)      | Haiku, Sonnet, Opus                                                   |
| claude-code       | none (subscription login)   | n/a — local CLI                         | default, sonnet, opus, haiku                                          |
| ibm-bob           | none (subscription login)   | n/a — local CLI                         | default                                                               |

The default provider is `openrouter`. `resolveConfiguredProvider()` picks the provider from `OPENWIKI_PROVIDER`, falling back to openrouter if `OPENROUTER_API_KEY` is set, then to `DEFAULT_PROVIDER`.

### Alternative base URLs

Set `ANTHROPIC_BASE_URL` to route the anthropic provider at an alternative,
Anthropic-compatible endpoint (for example a self-hosted or proxied gateway)
instead of the default API. When set, it is passed to `ChatAnthropic` as
`anthropicApiUrl`; the `ANTHROPIC_API_KEY` is still sent as the request
credential.

### OpenAI-compatible provider

The `openai-compatible` provider targets any OpenAI-compatible chat-completions
endpoint. It has no default endpoint, so `OPENAI_COMPATIBLE_BASE_URL` is
**required** (the interactive setup prompts for it, and a run aborts early if it
is missing). This is useful for OpenAI-compatible LLM endpoints such as those
exposed by a LiteLLM gateway, which lets you reach whatever upstream providers
the gateway fronts through a single OpenAI-shaped API.
Because the provider has no preset model
list, set `OPENWIKI_MODEL_ID` (or pick "custom model ID" in setup) to whatever
name the gateway exposes.

```bash
OPENWIKI_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_API_KEY=<gateway key>
OPENAI_COMPATIBLE_BASE_URL=https://<gateway>/v1
OPENWIKI_MODEL_ID=<model name the gateway exposes>
```

Base URLs are resolved by `resolveProviderBaseUrl()` in `src/constants.ts`, which
prefers a provider's `baseUrlEnvKey` override over the built-in default.

### Claude Code subscription provider

The `claude-code` provider runs documentation runs through an installed Claude
Code CLI using your subscription login instead of a metered API key:

```bash
OPENWIKI_PROVIDER=claude-code
OPENWIKI_MODEL_ID=default   # or sonnet / opus / haiku
```

Set `OPENWIKI_CLAUDE_CODE_BINARY` to point at a non-default binary and
`OPENWIKI_AGENT_CLI_TIMEOUT_SECONDS` to change the 30-minute run timeout. See
[Agent workflow](../agent/workflow.md) for how the engine executes runs and
which tools it allows.

### IBM Bob subscription provider

The `ibm-bob` provider runs documentation runs through an installed Bob Shell
CLI (`bob`) using your IBMid subscription login instead of a metered API key:

```bash
OPENWIKI_PROVIDER=ibm-bob
OPENWIKI_MODEL_ID=default   # the only preset option; the subscription default
```

Run `bob` once in the target repository to complete the IBMid login and trust
the folder when prompted — Bob refuses write-enabled headless runs in untrusted
folders. Set `OPENWIKI_IBM_BOB_BINARY` to point at a non-default binary and
`OPENWIKI_AGENT_CLI_TIMEOUT_SECONDS` to change the 30-minute run timeout. See
[Agent workflow](../agent/workflow.md) for how the engine executes runs and
which tools it allows.

## Help text and validation

The help content is centralized in `src/commands.ts` and is used by the CLI UI. Model validation is intentionally strict:

- model IDs are trimmed,
- they must match the allowed character pattern (`/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u`),
- URLs are rejected.

## What to change when editing the CLI

- Update parser behavior in `src/commands.ts` first.
- Then update any user-visible text in `src/cli.tsx` and `README.md`.
- If new options affect run behavior, make sure `src/agent/index.ts` and `src/credentials.tsx` still receive the right inputs.
- If adding an API provider, update `PROVIDER_CONFIGS` and `SELECTABLE_OPENWIKI_PROVIDERS` in `src/constants.ts`, `managedEnvKeys` in `src/env.ts`, and the `createModel` branch in `src/agent/index.ts`. For agent-CLI providers, add a `kind: "agent-cli"` config entry and register an adapter in `src/agent/engines/index.ts` instead of a `createModel` branch.
- To let a provider accept an alternative base URL, set `baseUrlEnvKey` on its `PROVIDER_CONFIGS` entry, add that key to `managedEnvKeys` in `src/env.ts`, and read it through `resolveProviderBaseUrl()` in the provider's `createModel` branch.
- To require a user-supplied base URL (a provider with no default endpoint, like `openai-compatible`), also set `requiresBaseUrl: true`. `ensureProviderBaseUrl()` in `src/agent/index.ts` enforces it at runtime, and the interactive setup adds a base-URL step for such providers.
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
