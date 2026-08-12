---
type: Technical documentation
title: Agent workflow
description: Explains the OpenWiki documentation agent's command flow, provider and model setup, prompting rules, and update metadata behavior. Documents the agent's Git-grounded workflow, content snapshot safeguards, and source implementation map for maintaining agent behavior.
tags: [agent, workflow, documentation, providers, update-metadata]
---

# Agent workflow

The documentation agent is implemented in `src/agent/`. It takes a command (`chat`, `init`, or `update`), gathers repository context, builds prompts, runs a DeepAgents session, and records successful update metadata — but only if the documentation content actually changed.

## Main flow

`src/agent/index.ts` follows this sequence for non-chat runs:

1. Load `~/.openwiki/.env` into `process.env`.
2. Resolve the provider via `resolveConfiguredProvider()` and ensure the provider's API key exists.
3. Resolve the model ID from CLI input, `OPENWIKI_MODEL_ID`, or the provider's default model, then validate the selected model's availability against the provider's catalogue via `getSelectedModelAvailability()` in `src/model-availability.ts`. For the `openai` provider (with an API key and the default OpenAI endpoint), this queries `GET https://api.openai.com/v1/models` and aborts the run with a clear message when the model is `unavailable`; a `unknown` result (non-OpenAI providers, custom OpenAI-compatible endpoints, a missing API key, or a lookup failure) is logged to the debug stream and proceeds to inference.
4. Create a run context from prior update metadata, persisted language, and the wiki brief. `createRunContext()` in `src/agent/utils.ts` no longer builds a Git summary: the agent runs `git` itself during the run per the prompt's Git-history instructions (the update prompt tells it to run `git rev-parse HEAD`, `git log <gitHead>..HEAD --name-status --oneline`, and `git diff` to scope changes). `RunContext` carries `lastUpdate`, `language`, and `wikiGoal` only.
5. Snapshot the current `openwiki/` content hash (before the run).
6. Build the system prompt and user prompt. `createSystemPrompt()` and `createUserPrompt()` in `src/agent/prompt.ts` select a prompt template by output mode — `CODE_SYSTEM_PROMPTS`/`CODE_USER_PROMPTS` from `src/agent/prompts/code.ts` for repository runs, `PERSONAL_SYSTEM_PROMPTS`/`PERSONAL_USER_PROMPTS` from `src/agent/prompts/personal.ts` for local-wiki runs — then substitute placeholders for language, Git-history hint, discovery instruction, `.openwikiignore` instructions, and runtime context. The user prompt's runtime context block (`{RUNTIME_CONTEXT}`) is produced by `formatRuntimeContext()` and carries the runtime root label and path (the `formatRuntimeRootInstruction()` helper moved here from `index.ts`).
7. Create the provider-specific model client (`ChatAnthropic`, `ChatOpenRouter`, or `ChatOpenAI`).
8. Create a DeepAgents `LocalShellBackend` rooted at the repository with a SQLite checkpointer, wrap it in a `CompositeBackend` via `createAgentBackend()` (an `OpenWikiCompositeBackend` subclass that turns a `RangeError` from an over-broad `glob` into a tool error rather than crashing the run), then attach OKF index middleware (`src/agent/okf-middleware.ts`) and translation middleware (`src/agent/translation-middleware.ts`). The `/conversation_history/` mount routes the DeepAgents summarization middleware's history offload to `~/.openwiki/conversation_history` so it succeeds even on docs-only runs (without it, the docs-only guard refuses the offload and summarization silently degrades — #496). `AGENT_FILESYSTEM_PERMISSIONS` denies the model's own writes to both `/skills/**` and `/conversation_history/**`. For `init` repository runs, the agent graph also registers init-only subagents (see [Init subagents](#init-subagents)). The OKF middleware migrates front matter before the agent runs, validates writes, and synchronizes `index.md` files after; its finalize stage also validates Mermaid fences and internal wiki links via `src/agent/wiki-link-validator.ts`, stamping broken links inline rather than aborting the run so a later update can repair them. The translation middleware translates eligible pages when the output language has changed.
9. Stream messages and tool events back to the CLI. The run now consumes the graph with `agent.stream(input, { streamMode: ["messages", "tools"], subgraphs: true })` rather than the older `streamEvents` v3 protocol. `parseAgentStreamChunk()` in `src/agent/index.ts` normalizes each `[namespace, mode, payload]` chunk into an `OpenWikiRunEvent`: `tools`-mode chunks become tool start/end events, `messages`-mode chunks become text events with `source: "main"` when the namespace is a single segment or `source: "subgraph"` when deeper (task output). `extractMessageText()` filters out non-text content blocks — `tool`, `reasoning`, `file`, and `image` types — so raw base64 payloads from file/image blocks never leak into the terminal output. A `scheduler.yield()` between chunks lets Ink paint streamed text before the async iterator advances. (`parseStreamEvent()` is retained for the public agent factory's Agent Protocol event shape, but the live run uses `parseAgentStreamChunk()`.) Before iterating, the runtime calls `registerActiveRun()` from `src/agent/crash-guard.ts` with the command, cwd, model id, output mode, pre-run snapshot, and language, so a rejection that escapes the for-await catch (e.g. a subagent error surfacing on the microtask queue) is still attributed; `clearActiveRun()` runs in the `finally`.
10. For `init` and `update`, compare the post-run content snapshot to the pre-run snapshot. Write `openwiki/.last-update.json` **only if the content changed** — or if the previous run was interrupted and this run completed, to clear the stale status. If the run fails mid-stream, the catch block writes metadata with `status: "interrupted"` so the next update retries instead of skipping as a no-op. After the run (success or failure), `recordRunSafe()` in `src/telemetry/` emits a single `openwiki_run` PostHog event with mode, provider, outcome, and latency. A rejection that escapes every catch is caught by the process-wide crash guard (see [Crash guard](#crash-guard)).

Chat runs skip metadata writes entirely.

## Provider-specific model creation

`createModel()` in `src/agent/index.ts` branches by provider:

- **gemini**: `new ChatGoogle({ apiKey, model, platformType: "gai" })` — uses the Gemini API key against Google AI Studio. Includes Gemini 3.x thought-signature round-trip options.
- **gemini-enterprise**: calls `createGeminiEnterpriseModel()`, which routes by model family via `resolveVertexSurface()` in `src/agent/vertex-surface.ts`. Claude models → `ChatAnthropic` with a custom `AnthropicVertex` client (`@anthropic-ai/vertex-sdk`, ADC-authenticated, env neutralized around the constructor so a stray `ANTHROPIC_API_KEY` cannot clobber the Google OAuth token). Partner/open-weight models (Llama, Mistral, DeepSeek, Qwen) → `ChatOpenAI` against Vertex's OpenAI-compatible MaaS endpoint with a per-request ADC auth fetch. Gemini/Gemma models → `ChatGoogle` with ADC and `apiKey: ""` to block `GOOGLE_API_KEY` fallback. Auth is uniform Google ADC; `GOOGLE_CLOUD_PROJECT` is required and `GOOGLE_CLOUD_LOCATION` is optional (defaults to `global`).
- **anthropic**: `new ChatAnthropic(modelId, { apiKey, anthropicApiUrl? })` — uses `@langchain/anthropic` directly. When `ANTHROPIC_BASE_URL` is set, the resolved alternative base URL is passed as `anthropicApiUrl` so requests can be routed to a self-hosted or proxied Anthropic-compatible endpoint instead of the default API.
- **openai-chatgpt**: `new ChatOpenAI({ apiKey: tokens.access, model, useResponsesApi: true, zdrEnabled: true, streaming: true, configuration: { baseURL: CODEX_RESPONSES_BASE_URL, defaultHeaders, fetch } })` — uses ChatGPT OAuth tokens instead of an API key. Tokens are refreshed before model creation via `ensureFreshChatGptTokens()` in `src/agent/openai-chatgpt-oauth.ts`. The Codex backend requires `store: false` (`zdrEnabled`) and streaming for all requests. If tokens are missing, the run aborts with a clear message directing the user to sign in.
- **openrouter**: `new ChatOpenRouter({ apiKey, baseURL, model, ...(maxTokens !== undefined ? { maxTokens } : {}), siteName: "OpenWiki" })` — uses the selected OpenRouter model directly. When `OPENWIKI_OPENROUTER_MAX_TOKENS` is set to a positive integer (resolved by `resolveOpenRouterMaxTokens()` in `src/config/constants.ts`), the cap is passed as `maxTokens` so OpenRouter's credit pre-check budgets against the cap rather than the model's full advertised output ceiling; without a cap, a low credit balance makes every request fail with a 402.
- **bedrock**: `new ChatBedrockConverse({ credentials: { accessKeyId, secretAccessKey }, model, region })` — uses `@langchain/aws` Bedrock Converse API with AWS credentials and a required region.
- **openai**: `new ChatOpenAI({ apiKey, model, useResponsesApi: true })` — uses OpenAI's Responses API for official OpenAI calls.
- **copilot**: `new ChatOpenAI({ apiKey, configuration: { baseURL? }, model, useResponsesApi: /^gpt-5/u.test(modelId) })` — uses the GitHub Copilot API endpoint. The API key is resolved before model creation via `resolveExternalCliCredential()` in `src/auth/external-cli-auth.ts`, which runs `gh auth token` and injects the credential into `process.env` for the current process only (never written to `~/.openwiki/.env`). For CI, `COPILOT_API_KEY` can be set directly to a GitHub OAuth token. The `responsesApi` setting is a regex so GPT models use the Responses API while Claude/Gemini models use standard chat completions. The `--hostname` flag matches the base URL tenant (for GHE.com data-residency hosts).
- **baseten / fireworks / nebius / nvidia / openai-compatible**: `new ChatOpenAI({ apiKey, configuration: { baseURL? }, model })` — OpenAI-compatible clients using the provider's base URL when configured. The `openai-compatible` provider has no default endpoint; its base URL is user-supplied via `OPENAI_COMPATIBLE_BASE_URL` and required (`requiresBaseUrl: true`), which lets OpenWiki target any OpenAI-compatible gateway (for example a LiteLLM gateway fronting upstream providers).

Base URLs are resolved through `resolveProviderBaseUrl()` in `src/config/constants.ts`, which prefers a provider's alternative base URL environment variable (`baseUrlEnvKey`) over the built-in default before falling back to the SDK's own default endpoint. Providers marked `requiresBaseUrl` are validated at startup by `ensureProviderBaseUrl()`.

Provider retry attempts are resolved through `resolveProviderRetryAttempts()` and passed to the LangChain model client's `maxRetries` option. The value is the number of retries after the first provider request; unset values default to 3 retries.

## Prompting strategy

`src/agent/prompt.ts` is the prompt assembler. It selects a template by output mode and substitutes placeholders; the prompt text itself lives in two sibling modules so the long product rules are kept out of the assembler:

- `src/agent/prompts/code.ts` — `CODE_SYSTEM_PROMPTS` / `CODE_USER_PROMPTS` for repository (`code`) runs. The `init` template drives a structured init workflow: build a `/openwiki/_skeleton.md` inventory, invoke the `skeleton_critic` subagent, resolve every requested change, fill the wiki, then verify with the `wiki_question_finder` and `wiki_answer_verifier` subagents, and finally write `quickstart.md`. The `update` template is the maintenance-update run contract (this wiki's own update prompt is the `CODE_USER_PROMPTS.update` template). The `chat` template steers wiki-first question answering.
- `src/agent/prompts/personal.ts` — `PERSONAL_SYSTEM_PROMPTS` / `PERSONAL_USER_PROMPTS` for `local-wiki` (personal brain) runs, including the canonical-file discipline (`/open-questions.md`, `/themes.md`, `/commitments.md`, `/personal-logistics.md`, `/sources/<connector>.md`) and contested-knowledge handling.

`createSystemPrompt()` substitutes `{OUTPUT_LANGUAGE_INSTRUCTIONS}`, `{GIT_HISTORY_HINT}`, `{DISCOVERY_INSTRUCTION}`, and `{OPENWIKIIGNORE_INSTRUCTIONS}`. For non-chat commands it appends link-integrity instructions. `createUserPrompt()` substitutes `{USER_MESSAGE}`, `{WIKI_GOAL}`, `{LAST_UPDATE}`, `{ADDITIONAL_USER_REQUEST}`, and `{RUNTIME_CONTEXT}` (the runtime context block, produced by `formatRuntimeContext()` in `prompt.ts`, carries the runtime root label and the `formatRuntimeRootInstruction()` path note).

The prompts instruct the agent to:

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

The run context built by `createRunContext()` in `src/agent/utils.ts` carries `lastUpdate`, `language`, and `wikiGoal` only. It no longer precomputes a Git summary: since the prompt refactor, the agent runs `git` itself during the run. The `CODE_SYSTEM_PROMPTS.update` template instructs the agent to run `git rev-parse HEAD`, read `/openwiki/.last-update.json`, then `git log <gitHead>..HEAD --name-status --oneline` (or recent history when no prior `gitHead` exists) and the relevant diff to scope the update. `.openwikiignore` exclusions are enforced by the filesystem backend rather than by pre-filtering a git summary.

On successful init/update runs where content changed, the agent writes JSON metadata with:

- `updatedAt`
- `command`
- `gitHead`
- `model`
- `status` — `"complete"` (default) or `"interrupted"`

That metadata is later used to scope update runs. When a run fails mid-stream, the catch block in `src/agent/index.ts` calls `persistRunMetadataIfChanged()` with `status: "interrupted"`, so already-generated content stays diffable. A rejection that escapes every catch is caught by the process-wide [crash guard](#crash-guard), which records the failure and stamps the same interrupted status post-mortem. `getUpdateNoopStatus()` then sees the interrupted status and does not skip the next update — preventing a possibly partial wiki from being treated as current. Metadata without a `status` field (from older versions) is treated as `"complete"`. A completed retry that changes no content still rewrites metadata to clear the interrupted status.

### Content snapshot

`createOpenWikiContentSnapshot()` computes a SHA-256 hash of the entire `openwiki/` directory tree (excluding `.last-update.json`). The agent runtime takes a snapshot before and after the run. If they match — meaning the model made no documentation changes — the metadata file is not updated, unless the previous run was interrupted and this run completed, in which case metadata is rewritten to clear the stale `"interrupted"` status. This prevents scheduled update loops from churning the metadata when the wiki is already current while still recovering from failed runs.

## Init subagents

Repository `init` runs register two read-only DeepAgents subagents through `createOpenWikiAgentGraph()` in `src/agent/index.ts`, gated by `command === "init" && outputMode === "repository"`:

- **`skeleton_critic`** (`src/agent/skeleton_critic.ts`, `resolveSkeletonCriticSubagents()`): an independent coverage reviewer. After the main agent researches the codebase and writes `/openwiki/_skeleton.md`, it invokes this subagent, which maps the repository itself before reading the skeleton and returns either `PASS` or `CHANGES_REQUESTED` with evidence-backed gaps. The main agent creates one TODO per returned `RQ` item, resolves them, then re-invokes the critic exactly once with the prior-request ledger. A third invocation is not allowed; any still-unresolved item is addressed directly.
- **`wiki_question_finder`** and **`wiki_answer_verifier`** (`src/agent/wiki_qa_subagents.ts`, `resolveWikiQaSubagents()`): a QA pair. The finder inspects repository source and tests (never `/openwiki`) and returns at most ~10 source-grounded questions with stable IDs, acceptance criteria, and motivating evidence. The main agent groups questions that share wiki pages into batches of 2–3, launches all batches for a wave in one parallel tool-call message, and the verifier checks each batch using only `/openwiki`, returning `PASS`, `PARTIAL`, or `FAIL` per question. For `PARTIAL`/`FAIL` results the main agent updates the canonical wiki pages, then re-verifies only the failing IDs with the changed pages (no resent criteria). This runs after the wiki is written.

Both subagents are read-only: they never create, edit, move, or delete files. They surface to the agent graph through the `subagents` option of `createDeepAgent`, and their output streams back as `source: "subgraph"` text/tool events via `parseAgentStreamChunk()`.

## Crash guard

`src/agent/crash-guard.ts` is the last-resort handler for rejections and exceptions that bypass every catch in the run — notably a subagent rejection surfacing on the microtask queue during streaming, which escapes the for-await catch. `installCrashGuard()` (called once at CLI startup in `src/cli/cli.tsx`) registers idempotent `unhandledRejection` and `uncaughtException` handlers. `runOpenWikiAgentCore()` in `src/agent/index.ts` calls `registerActiveRun()` with the command, cwd, model id, output mode, pre-run snapshot, and language for exactly the stream-consumption window, and `clearActiveRun()` in the `finally`.

When a fatal signal fires with an active run, `handleFatal()` best-effort:

1. records the crash as a failure via `recordRunSafe()` so it appears in telemetry, classified by `describeErrorForTelemetry()` (a residual `agent_error` carries the innermost error's allowlisted name as its `error_detail`, the same fingerprint boundary as every other failure — see [Credentials and updates § Error classification and fingerprinting](../operations/credentials-and-updates.md#error-classification-and-fingerprinting));
2. stamps the run `interrupted` via `persistRunMetadataIfChanged()` so the next scheduled update retries instead of no-op'ing against a half-written wiki;
3. writes a local stderr line and, when `OPENWIKI_DEBUG` is set, the stack; then exits non-zero via `setImmediate`.

`handleFatal()` claims the active run synchronously, before step 1 and before any `await`: it calls `getActiveRun()` followed immediately by `clearActiveRun()` with no await between them. The installer fires one `void handleFatal(...)` per escaped rejection, and a burst of subagent rejections lands on the microtask queue together; reading and clearing with no await in between makes the claim atomic for the event loop, so the first handler owns the crash and every later handler sees `undefined` and only exits. Do not move any `await` above that pair — doing so reintroduces the race where every rejection records the same run and one crash produces hundreds of duplicate events (`test/agent/crash-guard.test.ts`, "a burst of concurrent fatal signals records the crash exactly once").

Each side effect is wrapped and swallowed independently so a failure in one never blocks the other or the exit. The guard is the post-mortem counterpart to the catch block's interrupted-stamp path described under [Git evidence and update metadata](#git-evidence-and-update-metadata).

## Model errors

The agent runtime uses only the selected provider and model for a run. Before model creation, `getSelectedModelAvailability()` in `src/model-availability.ts` validates the selected model against the provider's catalogue: for the `openai` provider with an API key and the default endpoint, it calls the OpenAI Models API and aborts with a clear "does not make model available" message when the model is `unavailable`; every other case (non-OpenAI providers, custom OpenAI-compatible endpoints, missing API key, or a failed lookup) resolves to `unknown` and proceeds, so a catalogue lookup failure never blocks inference. Transient request failures use the LangChain model client's retry handling, configurable with `OPENWIKI_PROVIDER_RETRY_ATTEMPTS`. If the selected provider/model still fails, OpenWiki surfaces the provider error and stops instead of retrying with another model.

## Why this matters

The agent is not just a generic chat wrapper. It is intentionally constrained so it can:

- write repository-local docs without wandering outside the repo,
- preserve continuity across runs via checkpointing and metadata,
- keep updates grounded in Git evidence,
- avoid metadata churn via the content-snapshot check,
- support both interactive and scheduled maintenance use cases.

The same agent runtime is the wiki-generation backend invoked by the [DeepSWE evaluation harness](../evals/deepswe-harness.md), which runs it in an isolated clone to produce treatment wikis for paired benchmark trials.

## Things to watch when changing agent behavior

- Keep the prompt templates in `src/agent/prompts/code.ts` and `src/agent/prompts/personal.ts` in sync with the actual filesystem tools and path conventions used by the CLI. The assembler in `src/agent/prompt.ts` only substitutes placeholders; behavior changes go in the templates.
- Be careful with `.last-update.json` semantics, because update runs use it to decide what changed since the previous successful run. The `status` field (`"complete"` / `"interrupted"`) gates the no-op skip: `getUpdateNoopStatus()` does not skip when the previous run was interrupted, and a completed retry clears the status even without content changes. Both the catch block and the [crash guard](#crash-guard) stamp interrupted; keep both in sync if metadata semantics change.
- The content-snapshot check means a no-op update will not update metadata. If you change the snapshot logic, ensure `.last-update.json` is still excluded.
- Credential loading happens before model resolution; changes there affect both onboarding and agent startup.
- When adding a provider, add a branch in `createModel()` and ensure the API key env key is checked in `ensureProviderKey()`. OAuth-based providers (like `openai-chatgpt`) skip `ensureProviderKey()` and instead require a token refresh step before `createModel()` is called. Providers without an API key (like `gemini-enterprise`) declare their required env keys (e.g. `projectEnvKey`) in `PROVIDER_CONFIGS` and are gated by `getMissingProviderEnvKey()` instead. External-CLI-auth providers (like `copilot`) declare `authMethod: "external-cli"` and an `externalCliAuthAdapter`; `resolveExternalCliCredential()` in `src/auth/external-cli-auth.ts` probes the CLI at startup and injects the token into `process.env` for the current process only. AWS SDK providers (like `bedrock`) declare `authMethod: "aws-sdk"` and delegate credential resolution to the AWS SDK chain, accepting standard AWS env vars, OIDC/web identity, IAM roles, or SSO profiles in addition to legacy Bedrock-specific keys.
- The DeepAgents backend is configured with `virtualMode: true`, which is important for documentation-only behavior. The custom `OpenWikiLocalShellBackend` in `src/agent/docs-only-backend.ts` adds docs-only write guards that restrict writes to the `openwiki/` directory in docs-only mode.
- `createAgentBackend()` wraps the wiki backend in an `OpenWikiCompositeBackend` (a `CompositeBackend` subclass) with `/skills/` and `/conversation_history/` mounts. The subclass overrides `glob` to convert a `RangeError` ("Maximum call stack size exceeded") from an over-broad pattern into a tool error so a runaway `**/*` glob no longer crashes the run (covered by `test/agent/conversation-history-offload.test.ts`). `CONVERSATION_HISTORY_MOUNT` must stay in sync with deepagents' hard-coded `/conversation_history` default (there is no override); a dependency bump that moves that default silently reintroduces #496, so the offload test suite includes a drift probe that drives the installed `createSummarizationMiddleware` against a recording backend. Both mounts are denied to the model's filesystem tools via `AGENT_FILESYSTEM_PERMISSIONS`; do not loosen those deny rules without closing the prompt-injection path they guard.
- The live run streams via `agent.stream({ streamMode: ["messages", "tools"], subgraphs: true })` and is normalized by `parseAgentStreamChunk()`. `parseStreamEvent()` remains for the public agent factory's Agent Protocol v3 event shape only — if you change streaming, update `parseAgentStreamChunk()` and `test/agent/stream-redaction.test.ts`, not the protocol parser.
- Connector tools are gated to personal/local-wiki runs: `createOpenWikiConnectorTools(options.outputMode)` returns `[]` for `repository` runs, so a code-mode run is never handed connector ingestion tools (which would otherwise throw on missing credentials and waste tokens). If you change that gating in `src/connectors/tools.ts`, update `test/connectors/raw-connector-tools.test.ts` ("connector tool run-mode gating (#444)").
- Init-only subagents are gated by `resolveSkeletonCriticSubagents()` and `resolveWikiQaSubagents()` (both `init` + `repository` only). Adding or changing the init verification loop means editing `src/agent/skeleton_critic.ts` / `src/agent/wiki_qa_subagents.ts` and the `CODE_SYSTEM_PROMPTS.init` template that drives them.
- The crash guard registers the active run only for the stream-consumption window; if you move streaming or add earlier fatal paths, ensure `registerActiveRun()`/`clearActiveRun()` still bracket the window a subagent rejection can escape through. Inside `handleFatal()`, the `getActiveRun()`/`clearActiveRun()` claim must stay synchronous (no `await` before or between them): it is the guard against a burst of escaped rejections producing one crash event rather than hundreds — asserted by `test/agent/crash-guard.test.ts` ("a burst of concurrent fatal signals records the crash exactly once").

## Source map

- `src/agent/index.ts`
- `src/model-availability.ts`
- `src/agent/prompt.ts`
- `src/agent/prompts/code.ts`
- `src/agent/prompts/personal.ts`
- `src/agent/skeleton_critic.ts`
- `src/agent/wiki_qa_subagents.ts`
- `src/agent/crash-guard.ts`
- `src/agent/utils.ts`
- `src/agent/types.ts`
- `src/agent/docs-only-backend.ts`
- `src/agent/openai-chatgpt-oauth.ts`
- `src/agent/okf-middleware.ts`
- `src/agent/wiki-link-validator.ts`
- `src/agent/translation-middleware.ts`
- `src/agent/vertex-surface.ts`
- `src/agent/skills.ts`
- `src/auth/external-cli-auth.ts`
- `src/config/constants.ts`
- `src/config/env.ts`
- `src/telemetry/`
