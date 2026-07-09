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

Then to ensure your documentation stays up-to-date, add the CI workflow for your Git provider to automatically open a PR or merge request with documentation updates:

- GitHub Actions: copy [openwiki-update.yml](./examples/openwiki-update.yml) into `.github/workflows/openwiki-update.yml`.
- GitLab CI: copy [openwiki-update.gitlab-ci.yml](./examples/openwiki-update.gitlab-ci.yml) into `.gitlab-ci.yml` or include it from your existing GitLab pipeline.

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

OpenWiki supports OpenRouter, Fireworks, Baseten, OpenAI, an OpenAI-compatible provider, Anthropic, Vertex AI, and AWS Bedrock out of the box. By default, there are a few models pre-defined (GLM 5.2, Kimi K2.6, Sonnet 5, etc) but for each inference provider, OpenWiki will allow you to specify your own custom model ID.

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

Base URLs (and all credentials) can be set in your environment or stored in `~/.openwiki/.env`.

### Vertex AI

The `vertexai` provider targets Google Cloud Vertex AI using a service account.
OpenWiki persists the path to your service account JSON key as
`GOOGLE_APPLICATION_CREDENTIALS` (the same variable the Google Cloud SDK and
`gcloud auth application-default login` use):

```bash
OPENWIKI_PROVIDER=vertexai
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
OPENWIKI_MODEL_ID=gemini-2.5-pro
```

Optionally override the resolved GCP project and Vertex location:

```bash
GOOGLE_CLOUD_PROJECT=your-gcp-project
GOOGLE_VERTEX_LOCATION=us-central1
```

### AWS Bedrock

The `bedrock` provider targets AWS Bedrock via the `Converse` API. Bedrock does
not use a single persisted API key; instead OpenWiki relies on the standard AWS
credential chain (`@aws-sdk/credential-provider-node`); configure credentials
the same way you would for the AWS CLI — environment variables, `aws configure`,
an IAM role, or a profile:

```bash
OPENWIKI_PROVIDER=bedrock
AWS_ACCESS_KEY_ID=your-access-key-id
AWS_SECRET_ACCESS_KEY=your-secret-access-key
AWS_REGION=us-east-1
OPENWIKI_MODEL_ID=anthropic.claude-sonnet-4-20250514-v1:0
```

The model ID is a Bedrock foundation model ID (for example
`anthropic.claude-sonnet-4-20250514-v1:0` or `amazon.nova-pro-v1:0`).

If there's an inference provider or model you'd like to see added, please open a PR!

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a PR. We intentionally keep PRs tightly scoped to one change each, and PRs that bundle unrelated changes may be closed with a request to split them.
