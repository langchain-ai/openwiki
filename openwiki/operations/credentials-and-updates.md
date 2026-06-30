# Credentials and updates

OpenWiki has two operational concerns that matter for both users and maintainers:

1. local credential storage in `~/.openwiki/.env`, and
2. persisted update metadata in `openwiki/.last-update.json`.

It also ships with a GitHub Actions workflow example for scheduled updates.

## Local credential storage

`src/env.ts` manages a private environment file under the user's home directory:

- directory: `~/.openwiki`
- file: `~/.openwiki/.env`

The file stores `OPENROUTER_API_KEY`, `OPENWIKI_MODEL_ID`, and optional LangSmith settings. The loader merges those values into `process.env`, while preferring existing process-level values over file values.

`src/credentials.tsx` provides the interactive bootstrap flow when required:

- prompts for the OpenRouter key,
- prompts for a model choice if no model is already set,
- optionally prompts for a LangSmith key,
- writes the results with restrictive file permissions,
- removes deprecated OpenAI-related environment variables when saving.

## Model and credential diagnostics

The env layer also produces diagnostics for the CLI UI. Those diagnostics report:

- where each credential came from,
- whether the value is unset,
- the apparent length,
- a masked preview,
- warnings for suspicious formatting such as whitespace or bracketed suffixes,
- invalid model IDs.

This makes startup problems easier to diagnose without exposing secret values.

## Update metadata

After successful `init` or `update` runs, `src/agent/utils.ts` writes `openwiki/.last-update.json` with:

- `updatedAt`
- `command`
- `gitHead`
- `model`

Update runs use this metadata to build a change summary since the previous successful OpenWiki execution.

### Content snapshot gating

Metadata is only written when the `openwiki/` directory content actually changed during the run. Before the agent stream begins, `createOpenWikiContentSnapshot()` computes a SHA-256 hash of all files under `openwiki/` (excluding `.last-update.json`). After the run, the hash is recomputed; if it is unchanged, `.last-update.json` is not written. This prevents no-op update runs from advancing the recorded `gitHead`, which would cause the next update to miss the change window.

## GitHub Actions workflow

The repository includes `.github/workflows/openwiki-update.yml` as a copyable scheduled update workflow. It:

- checks out the repository,
- installs Node.js 22,
- installs OpenWiki globally,
- runs `openwiki --update --print`,
- passes `OPENROUTER_API_KEY`, `OPENWIKI_MODEL_ID`, and `LANGSMITH_API_KEY` from GitHub secrets,
- opens a pull request with `peter-evans/create-pull-request`.

The workflow is a good reference for automated maintenance, but the repo also contains a more general `checks.yml` workflow for CI (formatting and linting via pnpm).

The `examples/openwiki-update.yml` file is a copyable version of the scheduled update workflow intended for use in external repositories that want automated OpenWiki documentation updates.

## Things to watch when changing operations

- The `.env` file lives outside the repository, so changes to its format should be conservative.
- Never document real secret values; only document the presence and purpose of the configuration.
- If update metadata semantics change, update both the agent runtime and the docs that explain how update runs are scoped.
- Scheduled automation depends on the same CLI entrypoint as local users, so workflow changes should be validated against `package.json` and the CLI help text.
- The default model is `z-ai/glm-5.2` (from `src/constants.ts`); if the default changes, update the scheduled workflow environment variable in `.github/workflows/openwiki-update.yml` which hardcodes the model ID.

## Source map

- `src/env.ts`
- `src/credentials.tsx`
- `src/agent/utils.ts`
- `src/agent/index.ts`
- `src/constants.ts`
- `.github/workflows/openwiki-update.yml`
- `examples/openwiki-update.yml`
- `README.md`
- Git evidence: commit `405ea96` (initial commit, single-commit repo)
