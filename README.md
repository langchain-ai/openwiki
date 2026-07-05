# OpenWiki

OpenWiki is a CLI that writes and maintains documentation for your codebase, built specifically for agents. It can also ingest local knowledge sources through built-in connectors and synthesize them into a local wiki.

![OpenWiki](https://raw.githubusercontent.com/langchain-ai/openwiki/main/static/openwiki.png)

## Install

```sh
npm install -g openwiki
```

## Quick Start

Initialize OpenWiki, configure your model and API key, then generate documentation

```sh
openwiki --init
```

Then to ensure your documentation stays up-to-date, add the GitHub action to your repository to automatically open a PR once a day with documentation updates: [openwiki-update.yml](./examples/openwiki-update.yml)

Copy the contents of that file into `.github/workflows/openwiki-update.yml` in your repository.

## Usage

Start the interactive CLI:

```sh
openwiki
```

Start OpenWiki with an initial request:

```sh
openwiki "Please generate documentation for this repository"
```

Run a single command and exit:

```sh
openwiki -p "Summarize what you can do"
```

Initialize OpenWiki:

```sh
openwiki --init
```

The interactive init flow asks whether to initialize Brain mode or Code mode.

Initialize repository code documentation instead of the default local brain wiki:

```sh
openwiki --init --mode code
```

Update existing documentation:

```sh
openwiki --update
```

Run an update that can ingest configured local connectors first:

```sh
openwiki --update "Refresh the wiki from configured connectors"
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

`openwiki` creates initial repository documentation in `openwiki/` when no wiki exists. Source ingestion runs and scheduled connector updates maintain the local general-purpose wiki in `~/.openwiki/wiki/`. By default, the CLI stays open after each run so you can send follow-up messages. Use `-p` or `--print` for a one-shot non-interactive run that prints the final assistant output.

Use `--mode brain` for the local second-brain wiki or `--mode code` for repository documentation. Bare interactive `openwiki --init` prompts for a mode; non-interactive runs and `openwiki --update` default to brain mode.

`openwiki` will automatically append prompting to your `AGENTS.md` and/or `CLAUDE.md` files to instruct your coding agent to reference it when searching for context. If the file does not already exist in your repository, OpenWiki will create it for you.

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
`~/.openwiki/onboarding.json`. On macOS, source schedules are installed as user
LaunchAgents under `~/Library/LaunchAgents/` and write logs under
`~/.openwiki/logs/`.

See the OpenWiki operations docs for credential storage and provider setup
notes.

## Customizing

OpenWiki supports OpenAI, OpenRouter, Fireworks, Baseten and Anthropic out of the box. The onboarding default is OpenAI with `gpt-5.5`, and each inference provider also includes pre-defined model options plus support for custom model IDs.

If there's an inference provider or model you'd like to see added, please open a PR!
