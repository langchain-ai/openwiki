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

## Codex and Claude Code

OpenWiki also ships as an agent-native plugin for Codex CLI and Claude Code CLI. This path follows the same documentation workflow as the `openwiki` CLI, but it uses the model already available inside Codex or Claude Code, so it does not require a separate OpenWiki provider API key.

### Codex CLI

Add this repository as a Codex plugin marketplace:

```sh
codex plugin marketplace add langchain-ai/openwiki --sparse .agents/plugins --sparse plugins/openwiki
```

Then start Codex, open `/plugins`, select the OpenWiki marketplace, and install the `openwiki` plugin. Invoke it naturally with `@openwiki`, for example:

```text
@openwiki initialize documentation for this repository
@openwiki update the OpenWiki docs from recent changes
@openwiki answer this from the existing OpenWiki docs: how does auth work?
```

For local development, run `codex plugin marketplace add .` from this repository instead.

### Claude Code CLI

Add this repository as a Claude Code plugin marketplace and install the plugin:

```sh
claude plugin marketplace add langchain-ai/openwiki --sparse .claude-plugin plugins/openwiki
claude plugin install openwiki@openwiki
```

Then run Claude Code and invoke the skill as:

```text
/openwiki:openwiki init
/openwiki:openwiki update
/openwiki:openwiki how is the CLI structured?
```

For local development, either run `claude --plugin-dir ./plugins/openwiki` or add the current checkout with `claude plugin marketplace add .`.

The plugin writes documentation under `openwiki/`, preserves the same `quickstart.md` entrypoint, updates `AGENTS.md` and/or `CLAUDE.md` with the standard OpenWiki reference section when appropriate, and writes `openwiki/.last-update.json` only when documentation content changes.

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

If there's an inference provider or model you'd like to see added, please open a PR!
