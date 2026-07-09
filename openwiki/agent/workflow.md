# Agent workflow

The documentation agent is implemented in `src/agent/`. It takes a command (`chat`, `init`, or `update`), gathers repository context, builds prompts, executes the run through one of two engines — a DeepAgents session for API providers, or a subscription agent CLI for `agent-cli` providers — and records successful update metadata, but only if the documentation content actually changed.

## Main flow

`src/agent/index.ts` follows this sequence for non-chat runs:

1. Load `~/.openwiki/.env` into `process.env`.
2. For `update` runs without a user message, run the update no-op check (see below). If the repository is unchanged since the last successful run, skip the agent entirely and return `skipped: true`.
3. Resolve the provider via `resolveConfiguredProvider()`. If it is an agent-CLI provider (`isAgentCliProvider()`), dispatch to the agent-CLI engine path (see below) instead of the DeepAgents path.
4. For API providers, ensure the provider's API key (and required base URL) exists.
5. Resolve the model ID from CLI input, `OPENWIKI_MODEL_ID`, or the provider's default model.
6. Create a run context from Git state and prior update metadata.
7. Snapshot the current `openwiki/` content hash (before the run).
8. Build the system prompt and user prompt.
9. Create the provider-specific model client (`ChatAnthropic`, `ChatOpenRouter`, or `ChatOpenAI`).
10. Create a DeepAgents `LocalShellBackend` rooted at the repository with a SQLite checkpointer.
11. Stream messages and tool events back to the CLI.
12. For `init` and `update`, compare the post-run content snapshot to the pre-run snapshot. Write `openwiki/.last-update.json` **only if the content changed**.

Chat runs skip metadata writes entirely.

## Provider-specific model creation

`createModel()` in `src/agent/index.ts` branches by provider:

- **anthropic**: `new ChatAnthropic(modelId, { apiKey, anthropicApiUrl? })` — uses `@langchain/anthropic` directly. When `ANTHROPIC_BASE_URL` is set, the resolved alternative base URL is passed as `anthropicApiUrl` so requests can be routed to a self-hosted or proxied Anthropic-compatible endpoint instead of the default API.
- **openrouter**: `new ChatOpenRouter({ apiKey, baseURL, model, siteName: "OpenWiki" })` — uses the selected OpenRouter model directly.
- **openai**: `new ChatOpenAI({ apiKey, model, useResponsesApi: true })` — uses OpenAI's Responses API for official OpenAI calls.
- **baseten / fireworks / openai-compatible**: `new ChatOpenAI({ apiKey, configuration: { baseURL? }, model })` — OpenAI-compatible clients using the provider's base URL when configured. The `openai-compatible` provider has no default endpoint; its base URL is user-supplied via `OPENAI_COMPATIBLE_BASE_URL` and required (`requiresBaseUrl: true`), which lets OpenWiki target any OpenAI-compatible gateway (for example a LiteLLM gateway fronting upstream providers).

Base URLs are resolved through `resolveProviderBaseUrl()` in `src/constants.ts`, which prefers a provider's alternative base URL environment variable (`baseUrlEnvKey`) over the built-in default before falling back to the SDK's own default endpoint. Providers marked `requiresBaseUrl` are validated at startup by `ensureProviderBaseUrl()`.

## Agent-CLI engine execution

Providers with `kind: "agent-cli"` in `PROVIDER_CONFIGS` (currently `claude-code`) do not create a model client at all. `runAgentCliRun()` in `src/agent/index.ts` builds an `EngineRunSpec` — command, repository root, model ID, the fully assembled user prompt (delivered on stdin), an OpenWiki system prompt that is **appended** to the vendor agent's own system prompt, and an optional vendor session ID for follow-ups — and hands it to the generic runner in `src/agent/engines/runner.ts`.

The runner:

- resolves the binary from the provider's `binaryEnvKey` (`OPENWIKI_CLAUDE_CODE_BINARY` for Claude Code) or the default (`claude`), and verifies the install via the adapter's `detectInstall()` (`<binary> --version`). A missing binary fails the run with the provider's install hint — no API key is involved.
- spawns the CLI headless, parses its NDJSON output line-by-line through the adapter's `parseEvent()`, and maps vendor events onto the same `OpenWikiRunEvent` stream the CLI UI already renders (text, `tool_start`/`tool_end`, debug).
- enforces a run timeout (default 1800 seconds, overridable via `OPENWIKI_AGENT_CLI_TIMEOUT_SECONDS`), killing the whole process group on expiry.
- records the vendor session ID per OpenWiki thread so interactive follow-ups resume the same vendor session, and surfaces failures with the stderr tail plus the install hint when the output looks like a login/auth problem.

The Claude Code adapter (`src/agent/engines/claude-code.ts`) runs `claude -p --output-format stream-json` with `--permission-mode acceptEdits` and a documentation-scoped `--allowedTools` allowlist: read/search tools, write/edit tools, read-only git commands, and the single exact `rm` needed to delete the temporary plan file. Network tools are deliberately excluded. A model ID of `default` means "use the subscription's default model" (no `--model` flag is passed).

After the engine run, the same content-snapshot check applies: `.last-update.json` is written only if the `openwiki/` hash changed.

## Prompting strategy

`src/agent/prompt.ts` encodes the product rules directly into the system prompt. The agent is instructed to:

- inspect the current codebase and write documentation under `openwiki/`,
- use filesystem discovery tools and git history rather than inventing facts,
- keep the initial wiki focused and navigable,
- avoid thin/slim pages — merge stubs into broader pages rather than creating many small directories,
- document the repository for both humans and future agents,
- respect the repository root as the only project in scope,
- avoid reading secrets or `.env` files,
- use git history for init and update runs,
- respect the temporary plan file and update metadata requirements,
- ensure top-level `/AGENTS.md` and/or `/CLAUDE.md` reference the OpenWiki quickstart (inserting or refreshing a standardized section).

The system prompt has two engine variants (`PromptEngine` in `src/agent/prompt.ts`): the `deepagents` variant instructs the model to use virtual paths like `/openwiki/quickstart.md` with the DeepAgents filesystem tools, while the `agent-cli` variant uses repository-relative paths (`openwiki/quickstart.md`) and the vendor CLI's native tools. Only the tooling guidance, path discipline, and plan-file notes differ; the documentation rules are shared.

The user prompt changes with the command:

- `init` includes the current Git summary and asks for fresh documentation.
- `update` includes last update metadata and a Git change summary.
- `chat` just forwards the user message.

## Git evidence and update metadata

`src/agent/utils.ts` is responsible for the repository evidence that the prompt sees:

- current working tree status,
- current HEAD,
- a change window since the last successful update when `.last-update.json` includes a `gitHead` or `updatedAt`,
- the most recent 20 commits with changed files for init runs (or updates without prior metadata),
- a diff summary against HEAD.

On successful init/update runs where content changed, the agent writes JSON metadata with:

- `updatedAt`
- `command`
- `gitHead`
- `model`

That metadata is later used to scope update runs.

### Content snapshot

`createOpenWikiContentSnapshot()` computes a SHA-256 hash of the entire `openwiki/` directory tree (excluding `.last-update.json`). The agent runtime takes a snapshot before and after the run. If they match — meaning the model made no documentation changes — the metadata file is not updated. This prevents scheduled update loops from churning the metadata when the wiki is already current.

### Update no-op detection

Before an `update` run even starts the agent, `getUpdateNoopStatus()` in `src/agent/utils.ts` checks whether there is anything to document. The run is skipped entirely (with a "no repository changes detected" message and `skipped: true` in the result) when all of these hold:

- `.last-update.json` records a `gitHead`,
- the worktree is clean (ignoring the metadata file itself), and
- every commit since the recorded head only touched `openwiki/` paths.

The check applies only when the user did not pass a message with `--update` (`shouldCheckUpdateNoop()`); an explicit message always runs the agent. This is a separate mechanism from the content-snapshot check above: the no-op check avoids starting a run at all, while the snapshot check decides whether a completed run gets new metadata.

## Model errors

The agent runtime uses only the selected provider and model for a run. If that
request fails, OpenWiki surfaces the provider error and stops instead of
retrying with another model.

## Why this matters

The agent is not just a generic chat wrapper. It is intentionally constrained so it can:

- write repository-local docs without wandering outside the repo,
- preserve continuity across runs via checkpointing and metadata,
- keep updates grounded in Git evidence,
- avoid metadata churn via the content-snapshot check,
- support both interactive and scheduled maintenance use cases.

## Things to watch when changing agent behavior

- Keep the prompt in sync with the actual filesystem tools and path conventions used by the CLI.
- Be careful with `.last-update.json` semantics, because update runs use it to decide what changed since the previous successful run.
- The content-snapshot check means a no-op update will not update metadata. If you change the snapshot logic, ensure `.last-update.json` is still excluded.
- Credential loading happens before model resolution; changes there affect both onboarding and agent startup.
- When adding an API provider, add a branch in `createModel()` and ensure the API key env key is checked in `ensureProviderKey()`. For agent-CLI providers, add an adapter in `src/agent/engines/` and register it in `src/agent/engines/index.ts` instead.
- The DeepAgents backend is configured with `virtualMode: true`, which is important for documentation-only behavior. Agent-CLI runs bypass DeepAgents and the checkpointer entirely; there the adapter's tool allowlist is the safety boundary, so review it when changing what agent-CLI runs may touch.

## Source map

- `src/agent/index.ts`
- `src/agent/prompt.ts`
- `src/agent/utils.ts`
- `src/agent/types.ts`
- `src/constants.ts`
- `src/env.ts`
- Git evidence: commits `ceded10`, `f89b05d`, `dfa73cc`, `a82759f`, `0fa1430`
