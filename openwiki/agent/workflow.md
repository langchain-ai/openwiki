# Agent workflow

The documentation agent is implemented in `src/agent/`. It takes a command (`chat`, `init`, or `update`), gathers repository context, builds prompts, runs a DeepAgents session, and records successful update metadata — but only if the documentation content actually changed.

## Main flow

`src/agent/index.ts` follows this sequence for non-chat runs:

1. Load `~/.openwiki/.env` into `process.env`.
2. Resolve the provider via `resolveConfiguredProvider()` and ensure the provider's API key exists.
3. Resolve the model ID from CLI input, `OPENWIKI_MODEL_ID`, or the provider's default model.
4. Create a run context from Git state and prior update metadata.
5. Snapshot the current `openwiki/` content hash (before the run).
6. Build the system prompt and user prompt.
7. Create the provider-specific model client (`ChatAnthropic`, `ChatOpenRouter`, or `ChatOpenAI`).
8. Create a DeepAgents `LocalShellBackend` rooted at the repository with a SQLite checkpointer.
9. Stream messages and tool events back to the CLI.
10. For `init` and `update`, compare the post-run content snapshot to the pre-run snapshot. Write `openwiki/.last-update.json` **only if the content changed**.

Chat runs skip metadata writes entirely.

## Provider-specific model creation

`createModel()` in `src/agent/index.ts` branches by provider:

- **anthropic**: `new ChatAnthropic(modelId, { apiKey, anthropicApiUrl? })` — uses `@langchain/anthropic` directly. When `ANTHROPIC_BASE_URL` is set, the resolved alternative base URL is passed as `anthropicApiUrl` so requests can be routed to a self-hosted or proxied Anthropic-compatible endpoint instead of the default API.
- **openrouter**: `new ChatOpenRouter({ apiKey, baseURL, model, siteName: "OpenWiki" })` — uses the selected OpenRouter model directly.
- **openai**: `new ChatOpenAI({ apiKey, model, useResponsesApi: true })` — uses OpenAI's Responses API for official OpenAI calls.
- **baseten / fireworks / openai-compatible**: `new ChatOpenAI({ apiKey, configuration: { baseURL? }, model })` — OpenAI-compatible clients using the provider's base URL when configured. The `openai-compatible` provider has no default endpoint; its base URL is user-supplied via `OPENAI_COMPATIBLE_BASE_URL` and required (`requiresBaseUrl: true`), which lets OpenWiki target any OpenAI-compatible gateway (for example a LiteLLM gateway fronting upstream providers).

Base URLs are resolved through `resolveProviderBaseUrl()` in `src/constants.ts`, which prefers a provider's alternative base URL environment variable (`baseUrlEnvKey`) over the built-in default before falling back to the SDK's own default endpoint. Providers marked `requiresBaseUrl` are validated at startup by `ensureProviderBaseUrl()`.

Provider retry attempts are resolved through `resolveProviderRetryAttempts()` and passed to the LangChain model client's `maxRetries` option. The value is the number of retries after the first provider request; unset values default to 3 retries.

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

The user prompt changes with the command:

- `init` includes the current Git summary and asks for fresh documentation.
- `update` includes last update metadata and a Git change summary.
- `chat` just forwards the user message.

### Local brain open questions

Local brain runs use `~/.openwiki/wiki/open-questions.md` as a compact queue for uncertainty about the user's wiki or core memory model, not as a place to copy unresolved questions from every source document. Good open questions are things that would impair future assistance, such as unclear recurring routines, missing locations, uncertain preferences, ambiguous people/org relationships, or contradictions between sources.

Do not add an open question merely because a Notion spec, meeting note, email thread, or source page contains open product/design questions. Keep those on source pages, `themes.md`, or `commitments.md` unless they are explicitly owned by the user or reveal a gap in the user's memory graph. Group similar questions under one topic key instead of creating many same-project entries.

The file should use three sections:

- `Active`: unresolved questions with `Owner`, `Seen`, `Evidence`, and optional `Notes`.
- `Answered`: previously open questions with `Evidence` linking to the canonical answer or source evidence, plus `Answered`.
- `Stale`: dropped questions with `Why` and `Last seen`.

The agent should read `open-questions.md` at the start of each local-wiki run when it exists, use the run's evidence to answer known questions, and return to the file at the end to add new unresolved questions or move answered ones out of `Active`. Answered entries should link to the answer evidence rather than duplicating an answer summary that can drift.

### Local brain themes

Local brain runs use `themes.md` as a compact trend index, not as a narrative page. Prefer a Markdown table with `Topic key`, `Theme/Signal`, `First seen`, `Last seen`, `Confidence`, `Sources`, `Evidence count`, `Status`, and `Evidence`. If a table is too cramped, use one short fielded entry per theme.

Each theme should have at most 1-2 short sentences of prose. Keep detailed examples, long context, source-specific item lists, and tweet/feed clusters in `sources/<connector>.md`, then link to that evidence from the theme row. Watchlist entries should be especially terse.

### Local brain commitments and logistics

Local brain runs use `commitments.md` for work commitments, follow-ups, approvals, deadlines, and scheduled work items. Entries should include `Owner` when inferable from evidence: `me`, `team`, `other:<name>`, or `unknown`.

Use `personal-logistics.md` for non-work personal items such as appointments, pickups, travel, household tasks, and life-admin deadlines. Personal logistics should not be mixed into `commitments.md` unless they are also work commitments.

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

## Model errors

The agent runtime uses only the selected provider and model for a run. Transient request failures use the LangChain model client's retry handling, configurable with `OPENWIKI_PROVIDER_RETRY_ATTEMPTS`. If the selected provider/model still fails, OpenWiki surfaces the provider error and stops instead of retrying with another model.

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
- When adding a provider, add a branch in `createModel()` and ensure the API key env key is checked in `ensureProviderKey()`.
- The DeepAgents backend is configured with `virtualMode: true`, which is important for documentation-only behavior.

## Source map

- `src/agent/index.ts`
- `src/agent/prompt.ts`
- `src/agent/utils.ts`
- `src/agent/types.ts`
- `src/constants.ts`
- `src/env.ts`
- Git evidence: commits `ceded10`, `f89b05d`, `dfa73cc`, `a82759f`, `0fa1430`
