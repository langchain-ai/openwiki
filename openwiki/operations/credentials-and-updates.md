# Credentials and updates

OpenWiki has two operational concerns that matter for both users and maintainers:

1. local credential storage in `~/.openwiki/.env`, and
2. persisted update metadata in `openwiki/.last-update.json`.

It also ships with a GitHub Actions workflow example for scheduled updates.

## Local credential storage

`src/env.ts` manages a private environment file under the user's home directory:

- directory: `~/.openwiki` (mode `0o700`)
- file: `~/.openwiki/.env` (mode `0o600`)

The file stores provider configuration and API keys:

- `OPENWIKI_PROVIDER` — the selected model provider
- `OPENWIKI_MODEL_ID` — the default model ID
- Provider API keys: `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `BASETEN_API_KEY`, `FIREWORKS_API_KEY`
- Optional LangSmith settings: `LANGSMITH_API_KEY`, `LANGCHAIN_PROJECT`, `LANGCHAIN_TRACING_V2`

The loader merges those values into `process.env`, while preferring existing process-level values over file values. Deprecated keys (`OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT`) are skipped on load and removed on save.

`src/credentials.tsx` provides the interactive bootstrap flow when required:

- prompts for a provider (arrow-key selection menu),
- prompts for the provider's API key,
- prompts for a model choice (arrow-key selection from the provider's model list, or a custom model ID),
- optionally prompts for a LangSmith key,
- writes the results with restrictive file permissions,
- removes deprecated OpenAI-related environment variables when saving.

The setup flow runs for **all** interactive commands (chat, init, and update) when credentials are missing — not just chat. In non-interactive mode (no TTY or `--print`), missing provider keys produce an error instead of a prompt.

## Provider resolution

`resolveConfiguredProvider()` in `src/constants.ts` determines the active provider:

1. If `OPENWIKI_PROVIDER` is set and valid, use it.
2. Otherwise, if `OPENROUTER_API_KEY` is present, default to `openrouter`.
3. Otherwise, fall back to `DEFAULT_PROVIDER` (`openrouter`).

`needsCredentialSetup()` in `src/credentials.tsx` checks whether the provider env var, the provider's API key, a model ID (unless overridden), and a LangSmith key are all present. Any missing value triggers the interactive flow.

## Model and credential diagnostics

The env layer also produces diagnostics for the CLI UI. Those diagnostics report:

- where each credential came from (`process.env`, `~/.openwiki/.env`, both, or `unset`),
- whether the value is unset,
- the apparent length,
- a masked preview,
- warnings for suspicious formatting such as whitespace, newlines, quotes, or bracketed suffixes,
- invalid model IDs,
- invalid provider values.

Diagnostics cover all five provider keys plus `OPENWIKI_PROVIDER`, `OPENWIKI_MODEL_ID`, and `LANGSMITH_API_KEY`. This makes startup problems easier to diagnose without exposing secret values.

## Update metadata

After successful `init` or `update` runs where the `openwiki/` content changed, `src/agent/utils.ts` writes `openwiki/.last-update.json` with:

- `updatedAt`
- `command`
- `gitHead`
- `model`

The content-change check uses `createOpenWikiContentSnapshot()`, which hashes the `openwiki/` directory (excluding `.last-update.json`). If the hash is identical before and after the run, metadata is not written. This prevents scheduled update loops from updating the timestamp when no documentation changed.

Update runs use this metadata to build a change summary since the previous successful OpenWiki execution — preferring `gitHead` for a precise commit range, falling back to `updatedAt` for a time-based range.

## GitHub Actions workflow

The repository includes `.github/workflows/openwiki-update.yml` as a copyable scheduled update workflow. It:

- runs on schedule (daily at 08:00 UTC) and on manual dispatch,
- checks out the repository,
- installs Node.js 22,
- installs OpenWiki globally,
- runs `openwiki --update --print`,
- passes `OPENROUTER_API_KEY`, `OPENWIKI_MODEL_ID`, and `LANGSMITH_API_KEY` from GitHub secrets,
- opens a pull request with `peter-evans/create-pull-request` scoped to the `openwiki` directory.

The workflow is a good reference for automated maintenance. The repo also contains a `checks.yml` workflow for CI (lint/format checks).

## Things to watch when changing operations

- The `.env` file lives outside the repository, so changes to its format should be conservative.
- Never document real secret values; only document the presence and purpose of the configuration.
- If update metadata semantics change, update both the agent runtime and the docs that explain how update runs are scoped.
- Scheduled automation depends on the same CLI entrypoint as local users, so workflow changes should be validated against `package.json` and the CLI help text.
- When adding a provider, update `managedEnvKeys` in `src/env.ts` so the env file is formatted correctly and diagnostics cover the new key.
- The content-snapshot check means CI runs that produce no changes will not update `.last-update.json` or open a PR with metadata-only changes.

## Source map

- `src/env.ts`
- `src/credentials.tsx`
- `src/constants.ts`
- `src/agent/utils.ts`
- `src/agent/index.ts`
- `.github/workflows/openwiki-update.yml`
- `README.md`
- Git evidence: commits `ceded10`, `f89b05d`, `8278c36`, `0fa1430`
