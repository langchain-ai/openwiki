---
type: CLI reference
title: OpenWiki CLI usage
description: Reference for OpenWiki command-line usage, including interactive and non-interactive runs, initialization and update modes, connector operations, and authentication setup. Covers provider configuration, model selection, validation, and the source files to update when changing CLI behavior.
tags: [openwiki, cli, commands, configuration, authentication]
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
- provider and model selection during the session (`/provider`, `/model`),
- interactive credential setup when required (including for init/update, not just chat),
- streaming agent text and tool events (tool-call strings are redacted via `sanitizeDiagnosticText()` before display; subagent lifecycle is shown as "task" start/finish labels),
- completed-run history and error display,
- exit handling for help, errors, and explicit `/exit` messages.

The UI persists provider and model selection back to `~/.openwiki/.env` through `saveOpenWikiEnv()`.

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
```

Behavior and bounds, from `src/visualize/server.ts`:

- The HTTP server binds to the loopback address `127.0.0.1` only — it is never exposed on the network. The preferred port defaults to `4321`; on `EADDRINUSE` it increments through up to 20 ports before failing.
- A positional path selects the wiki directory (default `openwiki`). If the directory is missing, the server fails fast with a message directing you to run `openwiki --init` first.
- `buildGraph()` in `src/visualize/graph.ts` parses the wiki into nodes (concept pages) and edges (Markdown links), exposing them at `/api/graph`.
- A recursive file watcher (`startWatch`) debounces changes (150 ms) and rebuilds the graph; connected browsers receive a reload event over an SSE stream at `/events`, so edits to the wiki files refresh the live graph and reader while the server runs.
- The page (`src/visualize/page.ts`) and client (`src/visualize/client.ts`) are server-owned static assets served at fixed routes (`/`, `/client.js`, `/client-lib.js`). The browser loads Mermaid and the graph/Markdown libraries from a pinned jsdelivr CDN, so an internet connection is required even though the server is local. The CSP pins script sources to `'self'` and the CDN origin; no `req.url` path is ever used to read a file from disk.
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
- When a `--language` request changes the primary language subtag (for example `en` to `zh`), the [translation middleware](../agent/workflow.md) (`src/agent/translation-middleware.ts`) runs a deterministic translate-all pass **before** the agent edits: every eligible concept page is translated into the target language and marked with an `openwiki_translation_pending` front-matter field. Pages left pending by a prior failed switch are retranslated individually on the next update.
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
- Re-check the `package.json` bin entry and scripts if the entrypoint changes. The bin entry is `./dist/cli/cli.js`; a `postbuild` script restores its executable bit (`chmod 0o755`) so `npm link` installs survive rebuilds.

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
- `src/config/env.ts`
- `src/agent/index.ts`
- `src/agent/openai-chatgpt-oauth.ts`
- `src/auth/oauth.ts`
- `src/auth/oauth-discovery.ts`
- `src/auth/providers.ts`
- `src/auth/configure.ts`
- `src/auth/ngrok.ts`
- `src/platform/language.ts`
- `src/visualize/server.ts`
- `src/visualize/graph.ts`
- `src/visualize/page.ts`
- `src/visualize/client.ts`
- `README.md`
- `package.json`
