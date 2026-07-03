# OpenWiki

OpenWiki is a CLI that writes and maintains documentation for your codebase, built specifically for agents.

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

Update existing documentation:

```sh
openwiki --update
```

Show help:

```sh
openwiki --help
```

`openwiki` creates initial documentation in `openwiki/` when no wiki exists. If `openwiki/` already exists, it refreshes that documentation from repository changes. By default, the CLI stays open after each run so you can send follow-up messages. Use `-p` or `--print` for a one-shot non-interactive run that prints the final assistant output.

`openwiki` will automatically append prompting to your `AGENTS.md` and/or `CLAUDE.md` files to instruct your coding agent to reference it when searching for context. If the file does not already exist in your repository, OpenWiki will create it for you.

On the first interactive run, OpenWiki will have you configure your inference provider, API key, and LLM. You will also be able to set a LangSmith API key to trace your OpenWiki runs to a LangSmith tracing project named "openwiki" (optional).

These configuration options and secrets will be saved to `~/.openwiki/.env` on your local machine.

## Customizing

OpenWiki supports OpenRouter, Fireworks, Baseten, OpenAI and Anthropic out of the box. By default, there are a few models pre-defined (GLM 5.2, Kimi K2.6, Sonnet 5, etc) but for each inference provider, OpenWiki will allow you to specify your own custom model ID.

### Anthropic base URL (gateways, Bedrock, Vertex)

The Anthropic provider talks to `api.anthropic.com` by default. To route it
somewhere else — an OpenAI/Anthropic-compatible gateway such as
[LiteLLM](https://docs.litellm.ai/), AWS Bedrock or GCP Vertex AI through a
compatible proxy, or a self-hosted endpoint — set `ANTHROPIC_BASE_URL`:

```sh
# ~/.openwiki/.env
OPENWIKI_PROVIDER="anthropic"
OPENWIKI_MODEL_ID="claude-sonnet-5"
ANTHROPIC_API_KEY="..."          # key/token your gateway expects
ANTHROPIC_BASE_URL="https://your-gateway.example.com/anthropic"
```

`ANTHROPIC_BASE_URL` overrides the default and is threaded into the underlying
`ChatAnthropic` client as `anthropicApiUrl`. Leave it unset to use Anthropic's
public API. This is the path for enterprise deployments that must route model
traffic through their own cloud contract or gateway rather than direct API
billing.

If there's an inference provider or model you'd like to see added, please open a PR!
