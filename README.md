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

OpenWiki supports OpenRouter, Fireworks, Baseten, OpenAI, Anthropic and GitHub Copilot out of the box. By default, there are a few models pre-defined (GLM 5.2, Kimi K2.6, Sonnet 5, etc) but for each inference provider, OpenWiki will allow you to specify your own custom model ID.

### GitHub Copilot

The GitHub Copilot provider routes inference through the OpenAI-compatible Copilot API (`https://api.githubcopilot.com`), so teams can reuse an existing Copilot subscription instead of provisioning a separate inference API key.

1. Get a token from a Copilot-enabled GitHub account. Supported token types (the same ones the GitHub Copilot CLI accepts):
   - a GitHub CLI OAuth token — `gh auth login` then `gh auth token`,
   - an OAuth token from an authenticated GitHub Copilot CLI session, or
   - a fine-grained personal access token (v2) with the **"Copilot Requests"** account permission. Classic PATs (`ghp_...`) are not supported.
2. Set the token as `COPILOT_API_KEY` (OpenWiki will prompt for it when you select GitHub Copilot during `openwiki --init`).
3. Select `GitHub Copilot` as the provider and choose a model (for example `gpt-5.5`).

The resulting `~/.openwiki/.env` looks like:

```env
OPENWIKI_PROVIDER="copilot"
OPENWIKI_MODEL_ID="gpt-5.5"
COPILOT_API_KEY="<your-copilot-token>"
```

In CI (such as the scheduled GitHub Actions workflow), set the `COPILOT_API_KEY` repository secret and export `OPENWIKI_PROVIDER=copilot` in the workflow environment.

If there's an inference provider or model you'd like to see added, please open a PR!
