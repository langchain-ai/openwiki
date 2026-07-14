# OpenWiki

OpenWiki is a CLI that writes and maintains agent wikis for codebases or purpose memory. It's built specifically for agents, can ingest local knowledge sources through built-in connectors or git repositories and synthesize them into a local wiki.

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

OpenWiki supports OpenAI (with an API key or a ChatGPT login), OpenRouter, Nebius Token Factory, Fireworks, Baseten, NVIDIA NIM, an OpenAI-compatible provider, and Anthropic out of the box. The onboarding default is OpenAI with `gpt-5.6-terra`, and each inference provider also includes pre-defined model options plus support for custom model IDs.

### Alternative base URLs

To route the Anthropic provider at an alternative, Anthropic-compatible endpoint
(for example a self-hosted or proxied gateway) instead of the default API, set
`ANTHROPIC_BASE_URL` alongside `ANTHROPIC_API_KEY`:

```bash
OPENWIKI_PROVIDER=anthropic
ANTHROPIC_API_KEY=your-key
ANTHROPIC_BASE_URL=https://your-gateway.example.com/anthropic
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

Base URLs (and all credentials) can be set in your environment or stored in `~/.openwiki/.env`.

### Provider retry attempts

OpenWiki uses LangChain's built-in retry handling for transient provider errors.
To override the number of retries after the first provider request, set `OPENWIKI_PROVIDER_RETRY_ATTEMPTS`:

```bash
OPENWIKI_PROVIDER_RETRY_ATTEMPTS=3
```

The value must be a positive integer. If the value is unset, OpenWiki defaults to 3 retries.

If there's an inference provider or model you'd like to see added, please open a PR!

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a PR. We intentionally keep PRs tightly scoped to one change each, and PRs that bundle unrelated changes may be closed with a request to split them.
