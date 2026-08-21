---
type: CLI reference
title: OpenWiki CLI usage
description: Reference for OpenWiki command-line usage, including interactive and non-interactive runs, initialization and update modes, connector operations, and authentication setup. Covers provider configuration, model selection, validation, and the source files to update when changing CLI behavior.
tags: [openwiki, cli, commands, configuration, authentication]
generated: { by: "openwiki/0.3.3", at: "2026-08-20T08:11:55.370Z" }
---

# CLI usage

OpenWiki ships as a single `openwiki` binary and is intended to work both as an interactive terminal app and as a one-shot documentation runner.

## Commands and modes

From `src/cli/commands.ts` and `README.md`, the supported entry patterns are:

- `openwiki` — open the interactive chat UI.
- `openwiki "message"` — send a chat message immediately, then stay open.
- `openwiki personal --init [message]` — generate initial local personal brain wiki documentation.
- `openwiki code --init [message]` — generate initial repository documentation.
- `openwiki --update [message]` — refresh existing OpenWiki documentation.
- `openwiki -p, --print` — run once and print the final assistant output (non-interactive).
- `openwiki --modelId <id>` / `--model-id <id>` — choose a model ID for the run.
- `openwiki --language <locale>` / `-l <locale>` — generate the wiki in a specific language (BCP-47 locale, e.g. `zh-CN`, `hi`, `pt-BR`); see [Multilingual wikis](#multilingual-wikis).
- `openwiki visualize [path] [--port <port>] [--no-open]` — serve an interactive node-graph visualizer for a wiki directory on a local loopback address; see [Visualizer](#visualizer).
- `openwiki visualize [path] --export <dir>` — write a self-contained static visualizer directory (no server) for web hosting; see [Visualizer](#visualizer).
- `openwiki --help` / `-h` — print usage, options, and examples.
- `openwiki --dry-run` — development-only option that avoids invoking the agent.

### Connector and operational subcommands

- `openwiki auth <provider>` — run OAuth login for a connector provider (gmail, notion, slack, x). The `custom-mcp` connector is configured via `~/.openwiki/connectors/custom-mcp/config.json` instead of an OAuth login.
- `openwiki auth configure <provider> [--force]` — create local connector config that references saved auth env vars.
- `openwiki auth tools <provider>` — list available MCP tools for a connector (e.g. notion).
- `openwiki auth` (no provider) — list supported auth providers and their status.
- `openwiki ngrok start [url] [--port <port>]` — start an ngrok HTTPS tunnel for Slack OAuth callback.
- `openwiki cron list` — show saved connector schedules, launchd state, and the Mac wake window.
- `openwiki cron pause <source|all>` — unload launchd job(s), keep cron metadata, reconcile `pmset` wake window.
- `openwiki cron resume <source|all>` — reinstall paused launchd job(s) and reconcile `pmset` wake window.
- `openwiki cron delete <source|all>` — unload and remove schedule metadata (does not remove auth, config, raw data, or wiki content).
- `openwiki ingest [target]` — run source-specific ingestion for configured connectors.

The parser rejects incompatible combinations such as `--init` and `--update` together, and it requires a message or command when `--print` is used.

### Auto-exit for init/update

When explicit init (`openwiki personal --init` or `openwiki code --init`) or `--update` is run in a TTY (without `--print`), the CLI starts the run, streams agent output, and **exits automatically on success** (`shouldAutoExitStartupRun` in `src/cli/app/app.tsx`). Chat runs and `--print` runs are not affected — chat stays open for follow-ups, and `--print` writes to stdout and exits.

### Non-interactive mode

If stdin is not a TTY (e.g. CI), or `--print` is used, the CLI requires the provider's credentials to be already saved in `~/.openwiki/.env` or present in the environment — the provider API key, or `GOOGLE_CLOUD_PROJECT` for the gemini-enterprise provider. It will error with a clear message if the value is missing, rather than prompting interactively.

## Interactive behavior

`src/cli/app/app.tsx` is the Ink-based app shell. It handles:

- chat submission and follow-up messages,
- `init` / `update` command launches (including from `/init` and `/update` slash commands),
- provider and model selection during the session (`/provider`, `/model`, `/effort` for reasoning-capable models),
- interactive credential setup when required (including for init/update, not just chat),
- streaming agent text and tool events (tool-call strings are redacted via `sanitizeDiagnosticText()` before display; subagent lifecycle is shown as "task" start/finish labels), folded into a bounded progress model (see [Run lifecycle display](#run-lifecycle-display)),
- completed-run history and error display,
- exit handling for help, errors, and explicit `/exit` messages.

The UI persists provider and model selection back to `~/.openwiki/.env` through `saveOpenWikiEnv()`.

### Run lifecycle display

Init and update runs render a bounded progress model rather than a raw streaming transcript. `src/cli/run-log/reducer.ts` folds each `OpenWikiRunEvent` (from `parseAgentStreamChunk()` in `src/agent/index.ts`) into a fixed set of log items:

- **`RunToolLogItem`** — one aggregate summary per run (not one line per tool call). It accumulates categorized counts (`actionCount`, `readCount`, `searchCount`, `writeCount`, `taskCount`, `errorCount`) and the set of `activeToolCallIds` still running. When a new tool starts, earlier main-agent narration is discarded because a later tool call proves that prose was narration rather than the final answer; the summary is updated in place rather than appending a line. On completion it settles to `status: "done"` or `"error"` and records unique `writtenPaths` (persistent OpenWiki `.md` pages, excluding `_plan.md`).
- **`RunActivityLogItem`** — one per exact filesystem path touched by a `read_file`/`write_file`/`glob`/`grep`/`ls` call. `src/cli/run-log/activity.ts` (`getToolPathActivities()`) normalizes the path to repository-relative form, classifies the operation (`read`/`search`/`write`) and scope (`openwiki`/`repository`), and `buildActivityTreeLines()` merges shared ancestry into a familiar tree shape without rendering inactive files. Each activity tracks its lifecycle (`active` → `recent`/`error`) as the owning tool call completes; `boundActivityLog()` keeps the log bounded to a recent-activity window.
- **`RunTextLogItem`** — the main agent's final text response, accumulated as one replaceable buffer.
- **`RunDebugLogItem`** — bounded diagnostic notices (max 20), shown as `- <message>` lines.

`src/cli/components/run-view.tsx` renders this model. While a run is live it shows a slow heartbeat spinner (`RunSpinner`), a stage label derived from active activities (`getRunStage()`: "Exploring the repository" / "Tracing affected documentation" / "Writing documentation"), the aggregate counts, and the activity tree split into sections ("Reading repository", "Reading OpenWiki", "Writing OpenWiki", "Writing repository") plus a bounded "Recent activity" list. On completion (`done`) it renders an outcome-first title via `formatRunCompletionTitle()` in `src/cli/run-log/summary.ts` — e.g. `Generated 2 OpenWiki pages in 3s` or `OpenWiki is up to date in <1s` — followed by up to 5 written page paths, secondary counts (writes omitted because the title already reports unique pages), diagnostics, and the final assistant text.

| Module                            | Role                                                                               | Focused tests                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/cli/run-log/reducer.ts`      | `appendRunLogEvent()` event folder; tool start/end; activity activation/completion | `test/cli/run-log/reducer.test.ts` ("appendRunLogEvent text handling", "appendRunLogEvent tool grouping")     |
| `src/cli/run-log/activity.ts`     | Path extraction, normalization, scope/operation classification, tree builder       | `test/cli/run-log/activity.test.ts` ("getToolPathActivities", "isOpenWikiPagePath", "buildActivityTreeLines") |
| `src/cli/run-log/summary.ts`      | Count formatting and completion-title builder                                      | `test/cli/run-log/summary.test.ts` ("formatRunCompletionTitle", "formatCompletedRunCounts")                   |
| `src/cli/run-log/tool-input.ts`   | Stringified-JSON tool arg parsing and target counting                              | `test/cli/run-log/tool-input.test.ts` ("parseToolInput", "countToolTargets")                                  |
| `src/cli/components/run-view.tsx` | `RunView` Ink component (live + completed states)                                  | `test/cli/components/run-view.test.tsx` ("RunView")                                                           |

When changing the run view, the reducer is the single fold point: new event types or display fields start there, then `run-view.tsx` renders them. `src/cli/format.ts` now exports only `formatCount()` (singular/plural noun formatting) and display helpers — the older `truncateLogOutput()`/`getSpinnerFrame()` helpers were removed when the raw transcript display was replaced by the bounded model.

## Credentials and onboarding

The first interactive run can prompt for:

- a **provider** (`OPENWIKI_PROVIDER`) — openai, openai-chatgpt, copilot, openrouter, anthropic, gemini, gemini-enterprise, bedrock, baseten, fireworks, nebius, nvidia, or openai-compatible,
- the **provider API key** (e.g. `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `OPENAI_COMPATIBLE_API_KEY`, `ANTHROPIC_API_KEY`, `BASETEN_API_KEY`, `FIREWORKS_API_KEY`, `GEMINI_API_KEY`, `NEBIUS_API_KEY`) — skipped for the gemini-enterprise provider, which instead prompts for a **GCP project** (`GOOGLE_CLOUD_PROJECT`, required) and a **GCP location** (`GOOGLE_CLOUD_LOCATION`, optional, defaults to `global`), and skipped for the bedrock provider, which instead prompts for AWS access key ID, secret access key, and region, and skipped for the copilot provider, which uses the GitHub CLI (`gh auth login`) instead of an API key,
- a **base URL** for providers that require one (the openai-compatible provider prompts for `OPENAI_COMPATIBLE_BASE_URL`),
- a **model ID** stored as `OPENWIKI_MODEL_ID` — chosen from the provider's model list or a custom ID,
- optional `LANGSMITH_API_KEY` for tracing.

If a LangSmith key is provided, onboarding also enables `LANGCHAIN_PROJECT=openwiki` and `LANGCHAIN_TRACING_V2=true`.

`src/setup/credentials.tsx` (thin re-export over `src/setup/credentials/` modules) determines whether setup is needed and walks the user through the missing values using arrow-key selection menus for provider and model. See [Credentials and updates](../operations/credentials-and-updates.md) for details.

## Provider and model selection

Providers and their model options are defined in `PROVIDER_CONFIGS` in `src/config/constants.ts`:

| Provider          | Env key                                                       | Base URL                                                | Models                                                                                |
| ----------------- | ------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| openai            | `OPENAI_API_KEY`                                              | (default, or `OPENAI_BASE_URL`)                         | 5.6 Terra, 5.6 Luna, 5.6 Sol, 5.5, 5.4 mini                                           |
| openai-chatgpt    | `OPENAI_CHATGPT_ACCESS_TOKEN`                                 | (Codex backend)                                         | Same as openai (OAuth login, no API key)                                              |
| copilot           | `COPILOT_API_KEY`                                             | `https://api.githubcopilot.com` (or `COPILOT_BASE_URL`) | GPT 5.6 Terra/Luna/Sol, 5.5, 5.4 mini; Claude Opus/Sonnet/Haiku/Fable; Gemini 2.5 Pro |
| openrouter        | `OPENROUTER_API_KEY`                                          | `https://openrouter.ai/api/v1`                          | GLM 5.2, Fusion, Kimi K2.7 Code, Claude Opus/Sonnet, GPT 5.4 mini/5.5                 |
| anthropic         | `ANTHROPIC_API_KEY`                                           | (default, or `ANTHROPIC_BASE_URL`)                      | Haiku, Sonnet, Opus                                                                   |
| gemini            | `GEMINI_API_KEY`                                              | (AI Studio)                                             | Gemini 3.6 Flash, 3.5 Flash/Lite, 3.1 Pro, 3 Flash, 3.1 Flash-Lite                    |
| gemini-enterprise | none (Google ADC) — `GOOGLE_CLOUD_PROJECT` required           | per `GOOGLE_CLOUD_LOCATION` (default `global`)          | Gemini models + Claude Haiku/Sonnet/Opus on Vertex AI; MaaS by pasting model ID       |
| bedrock           | `BEDROCK_AWS_ACCESS_KEY_ID` + `BEDROCK_AWS_SECRET_ACCESS_KEY` | per `BEDROCK_AWS_REGION` (required)                     | Account/region-specific; paste Bedrock model ID directly                              |
| baseten           | `BASETEN_API_KEY`                                             | `https://inference.baseten.co/v1`                       | GLM 5.2, Kimi K2.7 Code                                                               |
| fireworks         | `FIREWORKS_API_KEY`                                           | `https://api.fireworks.ai/inference/v1`                 | GLM 5.2, Kimi K2.7 Code                                                               |
| nebius            | `NEBIUS_API_KEY`                                              | `https://api.tokenfactory.nebius.com/v1/`               | Kimi K2.6                                                                             |
| nvidia            | `NVIDIA_API_KEY`                                              | `https://integrate.api.nvidia.com/v1`                   | Nemotron 3 Super/Ultra/Nano, DeepSeek V4 Pro, GPT-OSS 120B, Kimi K2.6                 |
| openai-compatible | `OPENAI_COMPATIBLE_API_KEY`                                   | `OPENAI_COMPATIBLE_BASE_URL` (required)                 | custom model ID only                                                                  |

The default provider is `openai`, and the default model is `gpt-5.6-terra`. `resolveConfiguredProvider()` picks the provider from `OPENWIKI_PROVIDER`, then falls back to the first configured provider API key in this order: OpenAI, OpenAI-compatible, OpenRouter, Anthropic, Baseten, Fireworks, Nebius, NVIDIA, Bedrock, and finally `DEFAULT_PROVIDER` in `src/config/constants.ts`.

### Provider retry attempts

Set `OPENWIKI_PROVIDER_RETRY_ATTEMPTS` to override the number of retries after
the first provider request. The value must be a positive integer:

```bash
OPENWIKI_PROVIDER_RETRY_ATTEMPTS=3
```

If the value is unset, OpenWiki defaults to 3 retries.

### Model output token limit

Set `OPENWIKI_MAX_OUTPUT_TOKENS` (a positive integer) to override the maximum number of tokens generated in a model response, for example `OPENWIKI_MAX_OUTPUT_TOKENS=8192`. If unset, OpenWiki does not override the model client's output token limit — it is spread as `maxTokens` to non-Google clients (anthropic, openai, openai-chatgpt, copilot, openrouter, baseten/fireworks/nebius/nvidia/openai-compatible, and the Vertex Claude/MaaS surfaces) and as `maxOutputTokens` to `ChatGoogle`/Vertex Gemini surfaces. Provider and model limits still apply; unsupported values may be rejected, while very small values can truncate responses or tool calls. Resolved by `resolveMaxOutputTokens()` in `src/config/constants.ts`; covered by `test/config/constants.test.ts` ("resolveMaxOutputTokens") and `test/agent/gemini-retry.test.ts` ("passes maxTokens to direct non-Google clients").

### Bedrock stream idle timeout

For the Bedrock provider, set `OPENWIKI_STREAM_IDLE_TIMEOUT` to control how long the client waits for the first or next streamed response chunk:

```bash
OPENWIKI_STREAM_IDLE_TIMEOUT=300000
```

The value is milliseconds and must be an integer from `0` to `2147483647`. Set it to `0` to disable the LangChain watchdog. If unset, OpenWiki preserves the `@langchain/aws` provider default. Prefer a sufficiently long finite timeout over disabling the watchdog so a stalled stream cannot hang forever. The override is Bedrock-only: `resolveStreamIdleTimeoutForProvider()` ignores a stale value when the active provider is not `bedrock` so a leftover setting does not throw for other providers. Resolved by `resolveStreamIdleTimeout()` in `src/config/constants.ts`; passed to `ChatBedrockConverse` as `streamIdleTimeout`; covered by `test/agent/bedrock-model.test.ts` ("passes streamIdleTimeout to ChatBedrockConverse") and `test/config/constants.test.ts` ("resolveStreamIdleTimeout", "resolveStreamIdleTimeoutForProvider").

### Reasoning effort

Set `OPENWIKI_REASONING_EFFORT` to configure reasoning for a supported provider and model. OpenAI GPT-5.6 models (`gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.6-sol` for the `openai` and `openai-chatgpt` providers) use the Responses API values `none`, `low`, `medium`, `high`, `xhigh`, and `max`. NVIDIA NIM's `nvidia/nemotron-3-super-120b-a12b` supports `none`, `low`, and `high` through the chat-completions `reasoning_effort` field. In an interactive chat, use `/effort` to choose an available value or `/effort default` to restore the provider default. Leave the variable unset to preserve the provider default; invalid provider, model, or effort combinations fail before a request is sent (resolved by `resolveReasoningConfig()` in `src/config/reasoning.ts`). A shell export takes precedence over the saved `~/.openwiki/.env` value until the next process, so the interactive UI warns when a saved choice is shadowed.

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

By default the provider uses standard chat completions (`useResponsesApi: false`)
so it works against gateways that only implement the `/chat/completions` shape.
Opt the provider into OpenAI's Responses API (`POST {baseURL}/responses`) by
setting `OPENWIKI_OPENAI_COMPATIBLE_USE_RESPONSES_API=true` — useful when the
gateway exposes a Responses-compatible endpoint and you want LangChain's
Responses-API tool-calling/SSE parsing. Any other value (unset, `"false"`, or a
malformed value) keeps chat completions. The opt-in is resolved by
`resolveOpenAiCompatibleUseResponsesApi()` in `src/config/constants.ts`, which
`providerUsesResponsesApi()` short-circuits on for the `openai-compatible`
provider; it is a non-secret managed key surfaced in credential diagnostics,
where a value other than `true`/`false` reports an `invalid boolean` warning.

```bash
OPENWIKI_OPENAI_COMPATIBLE_USE_RESPONSES_API=true   # opt into Responses API
```

By default the agent runs the `openai-compatible` provider on the **updates** stream mode (`["updates","tools"]`) instead of the **messages** mode the other providers use. Endpoints that stream reasoning deltas before the first `role:"assistant"` delta — notably z.ai GLM — aggregate to a `ChatMessageChunk` under messages mode, which the agent loop's `wrapModelCall` validator rejects (`expected AIMessage or Command, got object`, issue #659). Dropping messages mode routes the model through the non-streaming `_generate` path, which returns a proper `AIMessage`. The cost is no live token streaming for openai-compatible runs in the TUI. Endpoints known to emit a `role:"assistant"` first delta can opt back into live streaming with `OPENWIKI_OPENAI_COMPATIBLE_STREAM_MESSAGES=true`, resolved by `resolveOpenAiCompatibleStreamMessages()` in `src/config/constants.ts` (default false; only the literal `true` case-insensitive/trimmed enables it).

Separately, `OPENWIKI_OPENAI_COMPATIBLE_STREAMING=true` forces the HTTP streaming transport (SSE) for every generation — a different axis from the stream mode above. Some gateways serve only the streaming transport and answer non-streaming requests with HTTP 200 and empty content, leaving a blank wiki and no error (#655). It stays off by default because SSE is not guaranteed to survive proxies and load balancers at arbitrary third-party endpoints. Resolved by `resolveOpenAiCompatibleStreaming()` / `providerUsesStreaming()` in `src/config/constants.ts`; forwarded into the generated CI workflow by `createWorkflowProviderEnv()` in `src/ingestion/code-mode.ts` so scheduled runs behave like local ones.

Base URLs are resolved by `resolveProviderBaseUrl()` in `src/config/constants.ts`, which
prefers a provider's `baseUrlEnvKey` override over the built-in default.

### Gemini (AI Studio) provider

The `gemini` provider uses Google's Gemini models through AI Studio
(`platformType: "gai"`) with a `GEMINI_API_KEY`. It includes Gemini 3.x
thought-signature round-trip handling.

```bash
OPENWIKI_PROVIDER=gemini
GEMINI_API_KEY=<api key>
```

### Gemini Enterprise (Vertex AI) provider

The `gemini-enterprise` provider runs models through Google Vertex AI Model
Garden using Google Application Default Credentials (keyless — a service account
key via `GOOGLE_APPLICATION_CREDENTIALS`, `gcloud auth application-default
login`, or workload identity). `GOOGLE_CLOUD_PROJECT` is required;
`GOOGLE_CLOUD_LOCATION` is optional and defaults to `global` (resolved by
`resolveProviderLocation()` in `src/config/constants.ts`).

Model routing is automatic based on the model ID, via `resolveVertexSurface()`
in `src/agent/vertex-surface.ts`:

- **Claude models** (IDs matching `anthropic`/`claude`) → `ChatAnthropic` with a
  custom `AnthropicVertex` client (`@anthropic-ai/vertex-sdk`).
- **Partner/open-weight models** (Llama, Mistral, DeepSeek, Qwen, etc.) →
  `ChatOpenAI` against Vertex's OpenAI-compatible MaaS endpoint, with a
  per-request ADC bearer token injected by a custom fetch wrapper.
- **Gemini/Gemma models** → `ChatGoogle` with ADC and `apiKey: ""` to prevent
  a stray `GOOGLE_API_KEY` from hijacking the enterprise path.

```bash
OPENWIKI_PROVIDER=gemini-enterprise
GOOGLE_CLOUD_PROJECT=<gcp project id>
GOOGLE_CLOUD_LOCATION=global   # optional
```

Model IDs for Claude may carry an `@`-versioned suffix (for example
`claude-haiku-4-5@20251001`), which the model-ID validator accepts. MaaS model
IDs (e.g. `meta/llama-3.3-70b-instruct-maas`) can be pasted directly.

### AWS Bedrock provider

The `bedrock` provider uses `ChatBedrockConverse` (`@langchain/aws`) with AWS
credentials. It requires an access key ID (`BEDROCK_AWS_ACCESS_KEY_ID`), a
secret access key (`BEDROCK_AWS_SECRET_ACCESS_KEY`), and a region
(`BEDROCK_AWS_REGION`). Available model IDs are account- and region-specific,
so there is no preset model list — paste the Bedrock model ID directly (for
example `anthropic.claude-sonnet-5-20260101-v1:0`).

### GitHub Copilot provider

The `copilot` provider uses the GitHub Copilot API endpoint
(`https://api.githubcopilot.com`) and authenticates via the GitHub CLI rather
than a pasted API key. It is configured with `authMethod: "external-cli"` and
`externalCliAuthAdapter: "github-cli"`, so the interactive onboarding flow runs
`gh auth login` with a Copilot-enabled account and reads the token via
`gh auth token`. The token is reused for the current process only — it is never
written to `~/.openwiki/.env`, so the CLI remains the source of truth.

For CI and other headless runs, set `COPILOT_API_KEY` directly to a GitHub OAuth
token (not a Personal Access Token — `ghp_` and `github_pat_` tokens are
rejected by `validateExternalCliCredential()` because the Copilot API does not
accept them).

The provider's `responsesApi` setting is a regex (`/^gpt-5/u`), so GPT models
use the OpenAI Responses API while Claude and Gemini models use the standard
chat completions endpoint.

```bash
OPENWIKI_PROVIDER=copilot
# Interactive: run `gh auth login` with a Copilot-enabled account
# CI: set COPILOT_API_KEY to a GitHub OAuth token
```

The `--hostname` flag passed to `gh` matches the tenant of the configured base
URL (if `COPILOT_BASE_URL` points at a GHE.com data-residency host), so the
reused session authenticates against the correct GitHub instance.

### OpenRouter provider

The `openrouter` provider routes through `https://openrouter.ai/api/v1` using `OPENROUTER_API_KEY`. By default no `max_tokens` is sent, so OpenRouter's credit pre-check budgets for the model's full advertised output ceiling and on a low credit balance every request can fail with a 402 error. Cap the per-request output explicitly with `OPENWIKI_OPENROUTER_MAX_TOKENS` (a positive integer, resolved by `resolveOpenRouterMaxTokens()` in `src/config/constants.ts`):

```bash
OPENWIKI_PROVIDER=openrouter
OPENROUTER_API_KEY=<key>
OPENWIKI_OPENROUTER_MAX_TOKENS=8192
```

A cap trades those hard 402 failures for possible truncation (finish_reason `length`) when a long wiki generation genuinely needs more output tokens, so prefer the largest value your balance allows.

### Visualizer

`openwiki visualize` serves the generated wiki as an interactive node graph with a side-by-side Markdown reader in the browser (`src/visualize/server.ts`). It is a read-only viewer for already-generated docs, not a generation command.

```sh
openwiki visualize                       # serve ./openwiki on the default port
openwiki visualize openwiki --port 4400  # serve a different directory on port 4400
openwiki visualize openwiki --no-open    # do not open the browser automatically
openwiki visualize openwiki --export docs/openwiki-visualizer  # write a static visualizer directory
```

`--export <dir>` writes a self-contained static visualizer directory instead of starting the server (`src/visualize/static-export.ts`, `exportStaticVisualizer`). The directory contains `index.html`, `client.js`, `client-lib.js`, `styles.css`, and `graph.json` — a snapshot of the graph at export time. The static client reads `./graph.json` and never opens an SSE connection (no live reload), so the directory can be hosted by GitHub Pages, MkDocs, or any other static host without OpenWiki running. The parser rejects `--export` combined with `--port` or `--no-open` (`--export cannot be combined with --port or --no-open.`), and rejects `--export` without a directory argument. On success the runner prints `Exported static visualizer to <dir> (<pages> pages, <links> links).` and exits.

Behavior and bounds, from `src/visualize/server.ts` and `src/visualize/page.ts`:

- The HTTP server binds to the loopback address `127.0.0.1` only — it is never exposed on the network. The preferred port defaults to `4321`; on `EADDRINUSE` it increments through up to 20 ports before failing.
- A positional path selects the wiki directory (default `openwiki`). If the directory is missing, the server fails fast with a message directing you to run `openwiki --init` first.
- `buildGraph()` in `src/visualize/graph.ts` parses the wiki into nodes (concept pages) and edges (Markdown links), exposing them at `/api/graph`.
- A recursive file watcher (`startWatch`) debounces changes (150 ms) and rebuilds the graph; connected browsers receive a reload event over an SSE stream at `/events`, so edits to the wiki files refresh the live graph and reader while the server runs.
- The page (`src/visualize/page.ts`), client (`src/visualize/client.ts`), and stylesheet (`src/visualize/styles.css`) are server-owned static assets served at fixed routes (`/`, `/client.js`, `/client-lib.js`, `/styles.css`). The page is rendered by `renderPage(staticExport)`: the live page (`PAGE`) loads client modules and the stylesheet from absolute routes; the static page (`STATIC_PAGE`) loads `./client.js` and `./styles.css` and carries a CSP `<meta>` tag so the exported HTML keeps the same script restrictions without a server header. The browser loads Mermaid and the graph/Markdown libraries from a pinned jsdelivr CDN, so an internet connection is required even though the server is local. The shared `CSP` pins script sources to `'self'` and the CDN origin; `style-src` keeps `'unsafe-inline'` because `client.ts` writes inline `style=` attributes for legend swatches and sidebar dots; no `req.url` path is ever used to read a file from disk. The compiled browser assets are read once via `loadVisualizerAssets()` (shared between the live server and the static exporter). Since `tsc` does not copy non-TypeScript files, `scripts/copy-visualize-assets.cjs` (appended to `npm run build`) copies `styles.css` into `dist/visualize/` and fails the build if the source is missing or the result lands empty.
- The graph panel is resizable and collapsible: a draggable splitter between the graph and the reader adjusts the graph width (persisted as a percentage in `localStorage`), and a topbar toggle button collapses the graph entirely so the reader takes the full width (also persisted). The splitter's hit area is wider than its visible line to prevent a near-miss press from landing on the canvas, where force-graph would read a stationary press+release as a background click that deselects the open page; pointer events on the canvas are suppressed for the duration of a drag.
- Press Ctrl-C (SIGINT) to stop the server.

## Multilingual wikis

`--language <locale>` (alias `-l`) generates the wiki in a language other than English, while keeping code identifiers, file paths, commands, API names, URLs, and code blocks canonical. `resolveLanguage()` in `src/platform/language.ts` validates the value as a BCP-47 tag via `Intl.Locale`; an unrecognized value resolves to English with a warning suggesting a code such as `zh-CN`, `hi`, or `pt-BR`.

```sh
openwiki --init --language pt-BR
openwiki --update --language zh-CN
```

Language is persisted state, not a one-shot flag:

- On a run, the effective language is the validated `--language` flag, else the language recorded in `openwiki/.last-update.json` from the previous run, else English (resolved in `src/agent/utils.ts` as `requestedLanguage ?? lastUpdate?.language ?? "en"`, with the requested value validated by `resolveLanguage()` in `src/platform/language.ts`). An update without `--language` keeps the existing wiki consistent in its established language instead of producing a mix.
- The chosen language is written to the `language` field of `.last-update.json` so subsequent runs inherit it.
- When a `--language` request changes the primary language subtag (for example `en` to `zh`), the [translation middleware](../agent/workflow.md) (`src/agent/translation-middleware.ts`) runs a deterministic translate-all pass **before** the agent edits: every eligible concept page is translated into the target language and marked with an `openwiki_translation_pending` front-matter field. Pages left pending by a prior failed switch are retranslated individually on the next update. The subtag comparison uses the shared `getPrimaryLanguageSubtag()` in `src/platform/language.ts`, which treats an absent tag as English and returns malformed persisted values as written so they cannot accidentally compare equal to a valid requested tag.
- A language change also defeats the update no-op skip on a clean tree: `getUpdateNoopStatus()` in `src/agent/utils.ts` returns `shouldSkip: false` with reason `"output language changed"` when the requested primary subtag differs from the persisted wiki language, so the translation pass runs even though no source changed. This check runs in both the agent's update-noop gate and the CLI's pre-credential `canSkipCleanUpdateBeforeCredentials()` in `src/cli/startup.ts` (covered by `test/agent/update-noop.test.ts`, "does not skip a clean update that requests a different language").
- Deterministic, model-free localization (index section headings and the derived concept `type` label) is resolved by `resolveIndexLabels()` and `resolveConceptTypeLabel()` in `src/okf/index-labels.ts`, keyed by BCP-47 tag with region fallback to the primary subtag and then to English.

## Help text and validation

The help content is centralized in `src/cli/commands.ts` and is used by the CLI UI. Model validation is intentionally strict:

- model IDs are trimmed,
- they must match the allowed character pattern (`/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u`),
- URLs are rejected.

## What to change when editing the CLI

- Update parser behavior in `src/cli/commands.ts` first.
- Then update any user-visible text in `src/cli/app/app.tsx`, `src/cli/cli.tsx`, and `README.md`.
- If new options affect run behavior, make sure `src/agent/index.ts` and `src/setup/credentials.tsx` still receive the right inputs.
- If adding a provider, update `PROVIDER_CONFIGS` and `SELECTABLE_OPENWIKI_PROVIDERS` in `src/config/constants.ts`, `managedEnvKeys` in `src/config/env.ts`, and the `createModel` branch in `src/agent/index.ts`. OAuth-based providers (like `openai-chatgpt`) additionally need a token refresh flow and a dedicated branch in `createModel` that reads tokens from `process.env`. `apiKeyEnvKey` is optional — a provider without one (like `gemini-enterprise`) instead declares the env keys it needs (e.g. `projectEnvKey`), and `getMissingProviderEnvKey()` gates runs on whichever required key is absent. Providers with a paired secret (like `bedrock`) use `secretKeyEnvKey`, and providers requiring a region use `regionEnvKey` with `requiresRegion: true`.
- To let a provider accept an alternative base URL, set `baseUrlEnvKey` on its `PROVIDER_CONFIGS` entry, add that key to `managedEnvKeys` in `src/config/env.ts`, and read it through `resolveProviderBaseUrl()` in the provider's `createModel` branch.
- To require a user-supplied base URL (a provider with no default endpoint, like `openai-compatible`), also set `requiresBaseUrl: true`. `ensureProviderBaseUrl()` in `src/agent/index.ts` enforces it at runtime, and the interactive setup adds a base-URL step for such providers.
- To change agent streaming behavior per provider, edit the `streamMessagesEnabled`/`streamModes` resolution in `src/agent/index.ts` (the `openai-compatible` provider already gates `messages` vs `updates` there via `resolveOpenAiCompatibleStreamMessages()` in `src/config/constants.ts`) and the `managedEnvKeys`/diagnostics entry for any new opt-in env key; update `test/agent/stream-modes.test.ts` and `test/agent/stream-redaction.test.ts`. The HTTP-transport opt-in `OPENWIKI_OPENAI_COMPATIBLE_STREAMING` is a separate axis (`providerUsesStreaming()` in `src/config/constants.ts`, forwarded into the CI workflow by `createWorkflowProviderEnv()` in `src/ingestion/code-mode.ts`); update `test/openai-compatible-streaming.test.ts` and `test/ingestion/code-mode.test.ts` when changing it.
- To add reasoning-effort support for a provider/model, add a `ReasoningCapability` to `REASONING_CAPABILITIES` in `src/config/reasoning.ts`, wire the transport into the `createModel()` branch (`responsesReasoningOptions` for Responses-API models, `chatCompletionsReasoningOptions` for chat-completions `reasoning_effort`), and add an interactive `/effort` row via `getReasoningEffortMenuOptions()` in `src/cli/input/menu.ts` (which derives from the same capability table). The onboarding `reasoning-effort` step in `src/setup/credentials/steps.ts` and `use-init-setup.ts` walks after the model step. Update `test/agent/create-model.test.ts` ("createModel reasoning configuration"), `test/config/constants.test.ts` ("reasoning capabilities"), and `test/cli/components/chat.test.tsx`.
- Re-check the `package.json` bin entry and scripts if the entrypoint changes. The bin entry is `./dist/cli/cli.js`; a `postbuild` script restores its executable bit (`chmod 0o755`) so `npm link` installs survive rebuilds. The `build` script also runs `scripts/copy-visualize-assets.cjs` after `tsc` to copy `src/visualize/styles.css` into `dist/visualize/` (tsc does not emit non-TypeScript assets); when adding a new browser asset to the visualizer, add it to the `ASSETS` list in that script so the build copies and verifies it.

## Source map

- `src/cli/cli.tsx`
- `src/cli/app/app.tsx`
- `src/cli/commands.ts`
- `src/cli/runners.ts`
- `src/cli/diagnostics/error-diagnostics.ts`
- `src/cli/diagnostics/sanitize.ts`
- `src/cli/diagnostics/auth-fix.ts`
- `src/setup/credentials.tsx` (re-exports `src/setup/credentials/`)
- `src/config/constants.ts`
- `src/config/reasoning.ts`
- `src/config/env.ts`
- `src/cli/input/menu.ts`
- `src/cli/components/chat.tsx`
- `src/cli/components/run-view.tsx`
- `src/cli/run-log/` (`reducer.ts`, `activity.ts`, `summary.ts`, `tool-input.ts`, `types.ts`)
- `src/cli/format.ts`
- `src/agent/index.ts`
- `src/agent/openai-chatgpt-oauth.ts`
- `src/auth/oauth.ts`
- `src/auth/oauth-discovery.ts`
- `src/auth/providers.ts`
- `src/auth/configure.ts`
- `src/auth/ngrok.ts`
- `src/platform/language.ts`
- `src/visualize/server.ts`
- `src/visualize/static-export.ts`
- `src/visualize/graph.ts`
- `src/visualize/page.ts`
- `src/visualize/client.ts`
- `src/visualize/styles.css`
- `scripts/copy-visualize-assets.cjs`
- `README.md`
- `package.json`
