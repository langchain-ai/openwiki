# OpenWiki

OpenWiki is a CLI that writes and maintains agent wikis for codebases or purpose memory. It's built specifically for agents, can ingest local knowledge sources through built-in connectors or git repositories and synthesize them into a local wiki.

<div align="center">
  <a href="https://trendshift.io/repositories/70339?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-70339" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/70339/daily" alt="langchain-ai%2Fopenwiki | Trendshift" width="250" height="55"/></a>
</div>

![OpenWiki](https://raw.githubusercontent.com/langchain-ai/openwiki/main/static/openwiki.png)

## Install

```sh
npm install -g openwiki
```

On Windows, prefer installing OpenWiki with Node.js package managers such as
`npm` or `pnpm`:

```sh
npm install -g openwiki
# or
pnpm add -g openwiki
```

`bun install -g openwiki` can fall back to compiling OpenWiki's `better-sqlite3`
checkpointing dependency. Before using that path, install Visual Studio Build
Tools with the Desktop development with C++ workload. Bun does not run lifecycle
scripts from installed packages by default, so it cannot display a package-level
warning before that native dependency build starts.

## Quick Start

Initialize OpenWiki in code mode, configure your model and API key, then generate documentation:

```sh
openwiki --init
```

OpenWiki has two modes:

- **Personal mode** builds a local personal brain wiki in `~/.openwiki/wiki` from
  configured sources like local repositories, Gmail, Notion, Web Search, Hacker
  News, and X/Twitter.
- **Code mode** builds repository documentation in `openwiki/` for the current
  codebase.

Bare `openwiki --init` and `openwiki --update` run in code mode. Use
`openwiki personal --init` or `openwiki personal --update` for the local
personal brain wiki.

Then to ensure your documentation stays up-to-date, add the CI workflow for your Git provider to automatically open a PR or merge request with documentation updates:

- GitHub Actions: copy [openwiki-update.yml](./examples/openwiki-update.yml) into `.github/workflows/openwiki-update.yml`.
- GitLab CI: copy [openwiki-update.gitlab-ci.yml](./examples/openwiki-update.gitlab-ci.yml) into `.gitlab-ci.yml` or include it from your existing GitLab pipeline.
- Bitbucket Pipelines: copy [openwiki-update.bitbucket-pipelines.yml](./examples/openwiki-update.bitbucket-pipelines.yml) into `bitbucket-pipelines.yml`, then schedule the `openwiki-update` custom pipeline from Repository settings > Pipelines > Schedules.

For repository documentation in GitHub Actions, use
`openwiki code --update --print`. You do not need to run `--init` in CI:
`--update` will create the initial `openwiki/` docs if they do not exist yet, as
long as the workflow provides the required provider and model environment
variables.

Scheduled/CI runs send anonymous reliability telemetry. See [Telemetry](#telemetry)
for what is collected and how to turn it off (uncomment `OPENWIKI_TELEMETRY_DISABLED`
in the example workflow).

## Open Knowledge Format compatibility

OpenWiki emits [Google Open Knowledge Format (OKF) v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) bundles in both code and personal modes.

- Every non-reserved Markdown concept has YAML front matter with a non-empty
  `type`; all other standard fields are optional.
- Valid `timestamp` values and producer-defined extension fields are accepted
  and preserved during updates and migrations.
- `index.md` and `log.md` are reserved documents rather than concepts. Nested
  indexes contain no front matter, while the root index declares
  `okf_version: "0.1"`.
- Standard Markdown links between concept documents express relationships.

## Usage

Start the interactive CLI in code mode for the current repository:

```sh
openwiki
```

Start OpenWiki with an initial request:

```sh
openwiki "Please generate documentation for this repository"
```

Start the interactive local personal brain instead:

```sh
openwiki personal
```

Run a single command and exit:

```sh
openwiki -p "Summarize what you can do"
```

Initialize OpenWiki:

```sh
openwiki --init
```

Initialize the local personal brain wiki:

```sh
openwiki personal --init
```

Update repository code documentation:

```sh
openwiki --update
```

Update the local personal brain wiki:

```sh
openwiki personal --update
```

Run an update that can ingest configured local connectors first:

```sh
openwiki personal --update "Refresh the wiki from configured connectors"
```

Show help:

```sh
openwiki --help
```

In chat, use `/api-key` to update the current provider API key and
`/langsmith-key` to update or clear LangSmith tracing credentials. Both commands
use masked prompts.

Authenticate a connector provider:

```sh
openwiki auth slack
openwiki auth gmail
openwiki auth x
openwiki auth notion
```

Start an ngrok tunnel for Slack OAuth:

```sh
openwiki ngrok start
```

This starts ngrok with a random HTTPS forwarding URL. OpenWiki reads ngrok's
local inspection API, appends `/callback`, and saves
`OPENWIKI_HTTPS_OAUTH_REDIRECT_URI` automatically. Register the printed callback
URL in Slack. If you have a fixed ngrok domain, run
`openwiki ngrok start https://<your-ngrok-domain>`. X/Twitter and Gmail auth
ignore that HTTPS override and keep using the local loopback callback,
`http://127.0.0.1:53682/callback`.

Bare `openwiki` runs in code mode for the current repository. It creates initial repository documentation in `openwiki/` when no wiki exists. Use `openwiki personal` for the local general-purpose wiki in `~/.openwiki/wiki/`. By default, the CLI stays open after each run so you can send follow-up messages. Use `-p` or `--print` for a one-shot non-interactive run that prints the final assistant output.

Bare `openwiki --init` and `openwiki --update` default to code mode and operate on repository documentation. Use the `personal` positional mode or `--mode personal` to initialize or update the local personal brain wiki.

On each `code` run, `openwiki` maintains both an `AGENTS.md` and a `CLAUDE.md` at the repository root, adding prompting that instructs your coding agent to reference the wiki when searching for context. Each file is created if it does not already exist. If a file is present, OpenWiki only rewrites its own `<!-- OPENWIKI:START -->…<!-- OPENWIKI:END -->` block and leaves the rest of your content untouched (appending the block the first time). The scheduled GitHub Actions workflow includes these files, along with the workflow itself, in the documentation pull request.

Repository-specific wiki instructions are stored separately in
`openwiki/INSTRUCTIONS.md`. This file is a shared, user-authored brief for the
repository wiki: OpenWiki reads it for scope and priorities, but it is not
generated documentation and is not rewritten during normal init, update, or chat
runs unless you explicitly ask to change the brief.

## Monorepos (recursive documentation)

Large monorepos are hard to capture in a single wiki. OpenWiki can instead
document each subproject in its own nested `openwiki/` sub-wiki, while the
repository-root wiki links down to them and covers only cross-cutting concerns:

```sh
openwiki code --update --recursive
```

Subprojects are read from an `openwiki/workspaces.json` manifest at the
repository root:

```json
{
  "version": 1,
  "workspaces": [{ "path": "packages/api" }, { "path": "packages/web" }],
  "overrides": {
    "packages/api": { "name": "API", "goal": "Optional per-subproject brief." },
    "vendor/thirdparty": { "exclude": true },
    "tools/custom-grouping": { "include": true, "name": "Tools" }
  },
  "root": { "goal": "Optional brief for the aggregating root wiki." }
}
```

The manifest has two parts. The `workspaces` list is **managed** — it is
regenerated from detection on every recursive run, sorted and path-only. All
hand-authored customization lives in the `overrides` map, keyed by
repo-relative path, and is never auto-clobbered:

- `goal` / `name`: a per-subproject wiki brief and display name.
- `exclude: true`: detection still lists the path (so it is not re-discovered as
  new noise), but no sub-wiki is generated for it.
- `include: true`: force-add a path detection cannot find (e.g. a custom
  grouping). This flag is also what distinguishes a deliberate manual addition
  from an override left behind by a deleted project.

The legacy flat shape (`goal`/`name` written directly on `workspaces` entries)
is still read: those fields are migrated into `overrides` in memory, and the
next write emits the current shape without losing them.

- **Self-maintaining discovery.** Detection re-runs on **every** recursive run
  (it is deterministic and fast) and is merged with the existing manifest, so
  the manifest stays current as the repo evolves: newly added projects appear
  automatically, deleted ones drop out, and your `overrides` survive
  regeneration. The merged manifest is written back **only when it changed** — a
  no-op run leaves `openwiki/workspaces.json` byte-for-byte unchanged, so
  scheduled CI runs produce no spurious manifest diff.
- **Manual entries are preserved, stale ones are pruned.** On the first
  self-maintaining run, any path you hand-listed that detection cannot surface
  is kept **if its directory still exists** — it is promoted to an explicit
  `"include": true` override (carrying any goal/name) so it is stable and
  self-documenting. A referenced path whose directory is gone is treated as a
  removed project and dropped; if it carried a hand-authored override, a warning
  names the pruned path (a plain managed entry is removed quietly). An
  `"include"` path that would overlap a detected workspace (for example an
  ancestor of a detected leaf) is ignored with a warning rather than persisted,
  so a stray include can never wedge future runs.
- **Activation.** If `openwiki/workspaces.json` is present, recursive mode is
  enabled automatically. Passing `--recursive` with no manifest triggers
  auto-detection of common workspace layouts (pnpm/npm/yarn workspaces, Cargo,
  Go, uv, Gradle, Maven, .NET solutions, Bazel), writes a `workspaces.json` for
  you to review, and proceeds. Pass `--recursive=false` to force a single-repo
  run even when a manifest exists.
- **Layout.** Each subproject's docs live at `<subproject>/openwiki/`. The root
  wiki gets a generated `openwiki/workspaces.md` index linking to every
  sub-wiki; do not hand-edit it.
- **Incremental updates.** Each subproject is evaluated independently: on
  `--update`, a subproject's sub-wiki regenerates only when files _within that
  subproject's own subtree_ have changed since it was last documented (tracked in
  its own `openwiki/.last-update.json`). Unchanged subprojects are skipped
  without a model call, so scheduled refreshes stay cheap. The root wiki
  regenerates on every run.
- **Known limitation — no dependency cascade.** Updates do not propagate across
  subprojects. If a shared subproject (for example a common kernel or contracts
  package) changes, only _that_ sub-wiki and the root wiki are refreshed — the
  sibling subprojects that depend on it are **not** automatically regenerated,
  even though their documented context may reference the changed code. Until
  dependency-aware invalidation exists, force a full refresh after a significant
  shared-code change by removing the relevant `openwiki/.last-update.json` files
  (or running each affected subproject explicitly).

On the first interactive run, OpenWiki will have you configure your inference provider, API key, and LLM. You will also be able to set a LangSmith API key to trace your OpenWiki runs to a LangSmith tracing project named "openwiki" (optional).

These configuration options and secrets will be saved to `~/.openwiki/.env` on your local machine.

## Local Connectors

OpenWiki's first-run onboarding offers connector setup for local Git repositories, Notion, Gmail, X/Twitter, Web Search, and Hacker News. During an ingestion run, deterministic connector tools write raw data and manifests under `~/.openwiki/connectors/<connector>/raw/`, then source-specific agent runs synthesize the local wiki under `~/.openwiki/wiki/` from those local files.

You can configure the same connector more than once. For example, add one Web
Search source for AI research and another for NBA news; OpenWiki stores them as
separate source instances such as `web-search-1` and `web-search-2`. Run all
instances with `openwiki ingest all`, all instances for one connector with
`openwiki ingest web-search`, or one instance with
`openwiki ingest web-search-2`.

- `git-repo` reads configured local repository paths and writes compact manifests.
- `x` uses the X API directly with OAuth user-context credentials for home timeline, user posts, mentions, bookmarks, and list posts.
- `notion` targets the hosted Notion MCP server, so users should authenticate through Notion OAuth instead of pasting a Notion token into OpenWiki.
- `google` uses the Gmail API directly with OAuth user credentials to fetch recent mail, with room to add Drive, Calendar, and other Google providers later.
- `web-search` uses Tavily through LangChain and requires `TAVILY_API_KEY`.
- `hackernews` uses public Hacker News feed and search APIs, with no credentials required.

Connector secrets are referenced by env var name and stored in `~/.openwiki/.env`; connector config files should never contain raw secret values.

`openwiki auth <provider>` runs a local browser OAuth flow, saves returned tokens into `~/.openwiki/.env`, creates connector config when possible, and discovers MCP tools for MCP-backed providers. Slack and Gmail require app client credentials to already be set in that file; Notion uses dynamic client registration for hosted MCP; X uses OAuth 2.0 with PKCE. After `openwiki auth gmail`, the Google connector can ingest Gmail directly with no MCP transport setup.

`openwiki auth configure <provider>` and `openwiki auth tools <provider>` are advanced/retry commands for regenerating connector config or inspecting live MCP tools.

First-run onboarding also lets users choose a wiki template, customize its scope,
and save per-source ingestion notes and source schedules in
`~/.openwiki/onboarding.json`. The global personal wiki instructions are saved
in `~/.openwiki/INSTRUCTIONS.md`. On macOS, source schedules are installed as
user LaunchAgents under `~/Library/LaunchAgents/` and write logs under
`~/.openwiki/logs/`.

See the OpenWiki operations docs for credential storage and provider setup
notes.

## Customizing

OpenWiki supports OpenAI (with an API key or a ChatGPT login), OpenRouter, Gemini (AI Studio), Gemini Enterprise (Vertex AI), Nebius Token Factory, Fireworks, Baseten, NVIDIA NIM, an OpenAI-compatible provider, AWS Bedrock, and Anthropic out of the box. The onboarding default is OpenAI with `gpt-5.6-terra`, and each inference provider also includes pre-defined model options plus support for custom model IDs.

### Alternative base URLs

To route the Anthropic provider at an alternative, Anthropic-compatible endpoint
(for example a self-hosted or proxied gateway) instead of the default API, set
`ANTHROPIC_BASE_URL` alongside `ANTHROPIC_API_KEY`:

```bash
OPENWIKI_PROVIDER=anthropic
ANTHROPIC_API_KEY=your-key
ANTHROPIC_BASE_URL=https://your-gateway.example.com/anthropic
```

The `openai` provider likewise supports an alternative, OpenAI-compatible
endpoint (for example a self-hosted or proxied gateway) via `OPENAI_BASE_URL`,
set alongside `OPENAI_API_KEY`. This is useful for OpenAI-compatible gateways
that expose the Responses API, since the `openai` provider routes tool calls
through the Responses API (`/v1/responses`) rather than chat completions:

```bash
OPENWIKI_PROVIDER=openai
OPENAI_API_KEY=your-key
OPENAI_BASE_URL=https://your-gateway.example.com/v1
OPENWIKI_MODEL_ID=your-model-name
```

### OpenAI-compatible endpoints

The `openai-compatible` provider targets any OpenAI-compatible chat-completions
endpoint via a required base URL. This can be used for OpenAI-compatible LLM
endpoints like those exposed by a LiteLLM gateway when it is used as a gateway —
letting you reach whatever upstream providers the gateway fronts through a single
OpenAI-shaped API. Set the model ID to whatever name the gateway exposes:

```bash
OPENWIKI_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_API_KEY=your-gateway-key
OPENAI_COMPATIBLE_BASE_URL=https://your-gateway.example.com/v1
OPENWIKI_MODEL_ID=your-gateway-model-name
```

Local LLM servers that expose OpenAI-compatible chat completions use the same
provider. The model ID must match a model available from that local server:

```bash
# Ollama, after `ollama serve` and `ollama pull llama3.2`
OPENWIKI_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_API_KEY=ollama
OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1
OPENWIKI_MODEL_ID=llama3.2
openwiki --init
```

```bash
# LM Studio, after starting the local server from the Developer tab
OPENWIKI_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_API_KEY=lm-studio
OPENAI_COMPATIBLE_BASE_URL=http://localhost:1234/v1
OPENWIKI_MODEL_ID=your-loaded-model-id
openwiki --init
```

For local gateways such as 9Router, use the OpenAI-compatible endpoint URL,
API key, and model ID shown by the gateway:

```bash
OPENWIKI_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_API_KEY=your-local-gateway-key
OPENAI_COMPATIBLE_BASE_URL=http://localhost:20128/v1
OPENWIKI_MODEL_ID=your-routed-model-id
openwiki --init
```

Some local servers ignore the API key value, but OpenWiki still requires
`OPENAI_COMPATIBLE_API_KEY` because the OpenAI-compatible client expects one.

### AWS Bedrock

The `bedrock` provider calls foundation models hosted on AWS Bedrock using IAM
credentials rather than a single vendor API key. It authenticates with an AWS
access key ID, a secret access key, and a region:

```bash
OPENWIKI_PROVIDER=bedrock
BEDROCK_AWS_ACCESS_KEY_ID=your-access-key-id
BEDROCK_AWS_SECRET_ACCESS_KEY=your-secret-access-key
BEDROCK_AWS_REGION=us-east-1
OPENWIKI_MODEL_ID=anthropic.claude-sonnet-5
```

Which model IDs are available depends on your AWS account and region (which
foundation models you've enabled in the Bedrock console), so there is no
preset model list — paste the Bedrock model ID directly, as shown above.

Some newer models only accept on-demand invocation through a cross-region
inference profile rather than their bare model ID — if you see `ValidationException:
Invocation of model ID ... with on-demand throughput isn't supported`, prefix
the model ID with the profile's region code instead, for example
`us.anthropic.claude-sonnet-5`. Your IAM policy also needs to allow
`bedrock:InvokeModel`/`InvokeModelWithResponseStream` on both the
`foundation-model` and `inference-profile` resource types in that case.

### OpenAI (ChatGPT login)

The `openai-chatgpt` provider calls OpenAI's Codex backend using your ChatGPT
subscription instead of a metered API key. Model usage draws on your ChatGPT
Plus/Pro/Team plan's included Codex usage rather than per-token API billing. It
serves the same model list as the `openai` provider.

Instead of pasting an API key, run the setup wizard and complete a browser
login:

```bash
OPENWIKI_PROVIDER=openai-chatgpt openwiki code --init
# or
OPENWIKI_PROVIDER=openai-chatgpt openwiki personal --init
```

The wizard opens `https://auth.openai.com` in your browser (and also prints the
URL for headless/SSH use, where you can open it on another machine — or paste the
redirect URL back into the terminal to finish without a callback). After you sign
in with your ChatGPT account, OpenWiki captures the OAuth callback, shows the
signed-in email and plan, and then continues to model and LangSmith selection
just like the other providers. It stores the resulting access token, refresh
token, expiry, account id, email, and plan in `~/.openwiki/.env`
(`OPENAI_CHATGPT_ACCESS_TOKEN`, `OPENAI_CHATGPT_REFRESH_TOKEN`,
`OPENAI_CHATGPT_EXPIRES_AT`, `OPENAI_CHATGPT_ACCOUNT_ID`, `OPENAI_CHATGPT_EMAIL`,
`OPENAI_CHATGPT_PLAN`). These are managed for you — the access token is refreshed
automatically when it expires, so you normally never edit them by hand. Treat the
refresh token like a password.

### Gemini (AI Studio)

The `gemini` provider runs Google's Gemini models through the AI Studio API with
a single API key:

```bash
OPENWIKI_PROVIDER=gemini
GEMINI_API_KEY=your-ai-studio-key
```

### Gemini Enterprise (Vertex AI)

The `gemini-enterprise` provider runs models from the Gemini Enterprise Model
Garden (formerly Vertex AI) — Google's own Gemini/Gemma models, Anthropic's
Claude, and partner/open-weight models (Llama, Mistral, DeepSeek, Qwen, …). It
routes each model ID to the right API surface automatically, so one credential
reaches all of them. It uses no API key — authentication happens with Google
Application Default Credentials (ADC), so any of the standard mechanisms work:

- a service account key file via `GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json`,
- user credentials from `gcloud auth application-default login`, or
- workload identity when running on Google Cloud (GKE, Cloud Run, GCE) or in CI.

```bash
OPENWIKI_PROVIDER=gemini-enterprise
GOOGLE_CLOUD_PROJECT=your-gcp-project
GOOGLE_CLOUD_LOCATION=global   # optional, defaults to global
```

Set `OPENWIKI_MODEL_ID` to any Model Garden model. Gemini and Claude ship as
preset options; partner/open-weight models are reached by pasting their model ID
(for example `publishers/meta/models/llama-3.3-70b-instruct-maas`).

The credentials used need Vertex AI access (`roles/aiplatform.user`) in the
project, and the models you want must be enabled in the Model Garden. The
`global` endpoint serves Gemini and Claude and offers the best availability;
regional endpoints (for example `europe-west1` or `us-east5`) can be set via
`GOOGLE_CLOUD_LOCATION` for data-residency requirements. Partner/open-weight
(MaaS) models are region-specific, so set `GOOGLE_CLOUD_LOCATION` explicitly when
using them.

Note that `GOOGLE_CLOUD_PROJECT` (and `GOOGLE_APPLICATION_CREDENTIALS`, if you
choose to store it there) is persisted to `~/.openwiki/.env` and loaded into the
OpenWiki process environment at startup when not already set — values already
present in your shell always win.

For CI, authenticate before the update job runs — for example with
[`google-github-actions/auth`](https://github.com/google-github-actions/auth)
(workload identity federation) in GitHub Actions — and set
`OPENWIKI_PROVIDER=gemini-enterprise` and `GOOGLE_CLOUD_PROJECT` in the job
environment.

Base URLs (and all credentials) can be set in your environment or stored in `~/.openwiki/.env`.

### OpenRouter provider pinning

When OpenRouter serves a model through multiple upstream providers, set
`OPENWIKI_OPENROUTER_PROVIDER_ONLY` to restrict routing to one provider or a
comma-separated provider allowlist:

```bash
OPENWIKI_PROVIDER=openrouter
OPENROUTER_API_KEY=your-key
OPENWIKI_OPENROUTER_PROVIDER_ONLY=Novita
```

### Provider retry attempts

OpenWiki uses LangChain's built-in retry handling for transient provider errors.
To override the number of retries after the first provider request, set `OPENWIKI_PROVIDER_RETRY_ATTEMPTS`:

```bash
OPENWIKI_PROVIDER_RETRY_ATTEMPTS=3
```

The value must be a positive integer. If the value is unset, OpenWiki defaults to 3 retries.

If there's an inference provider or model you'd like to see added, please open a PR!

## Telemetry

OpenWiki collects anonymous, aggregate usage data so we can understand how the
tool is used and improve it. Telemetry is on by default and easy to turn off.

**What is collected**, on a single `openwiki_run` event, keyed by a random
install ID stored locally in `~/.openwiki/install-id`:

- Every run: the command (init / update) and the outcome (success / failure /
  no-op), plus a coarse error category on failure (never the error message).
  Interactive chat, `auth`, and `ingest` are not recorded.
- At setup (on init only): which brain mode (code / personal), the model
  provider, and which connectors you configured (connector names only, never
  their contents).

**What is never collected:** file contents, repository data or names,
credentials, prompts, model output, connector payloads, error messages, file
paths, URLs, model IDs, run duration, your IP address, or any personal
information. Geoip enrichment is disabled and your IP is never stored. Events
are grouped by your random install ID so we can measure repeat usage, but that
ID contains no personal data.

**Scheduled/CI runs** are collected as anonymous reliability data (tagged so
they can be told apart from human runs), under a shared CI identifier rather than
a per-machine install ID, and never counted as distinct installs. To disable in
CI, set `OPENWIKI_TELEMETRY_DISABLED=1` in your workflow environment.

To see exactly what a run would send, add `--telemetry-file=<path>` to any run.

### Opting out

Set either environment variable:

```sh
export OPENWIKI_TELEMETRY_DISABLED=1
# or the cross-tool standard:
export DO_NOT_TRACK=1
```

To disable permanently, add `OPENWIKI_TELEMETRY_DISABLED=1` to `~/.openwiki/.env`.
In CI, set it in the workflow environment (config files do not persist on
ephemeral runners).

### Seeing exactly what is sent

Add `--telemetry-file=<path>` to any run to also write the exact payload to a
local JSON file.

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a PR. We intentionally keep PRs tightly scoped to one change each, and PRs that bundle unrelated changes may be closed with a request to split them.
