# Credentials and updates

OpenWiki has four operational concerns that matter for both users and maintainers:

1. local credential storage in `~/.openwiki/.env`, and
2. persisted personal wiki instructions in `~/.openwiki/INSTRUCTIONS.md`,
3. persisted onboarding/schedule metadata in `~/.openwiki/onboarding.json`,
4. persisted update metadata in `openwiki/.last-update.json`.

It also ships with GitHub Actions and GitLab CI workflow examples for scheduled updates.

## Installation notes

On Windows, prefer installing OpenWiki with Node.js package managers such as
`npm` or `pnpm`. The Bun global-install path can fall back to compiling
`better-sqlite3`, which requires Visual Studio Build Tools with the Desktop
development with C++ workload. Bun does not run lifecycle scripts from installed
packages by default, so OpenWiki cannot show an install-time warning before that
native dependency build begins.

## Local credential storage

`src/env.ts` manages a private environment file under the user's home directory:

- directory: `~/.openwiki` (mode `0o700`)
- file: `~/.openwiki/.env` (mode `0o600`)

The file stores provider configuration and API keys:

- `OPENWIKI_PROVIDER` — the selected model provider
- `OPENWIKI_MODEL_ID` — the default model ID
- `OPENWIKI_PROVIDER_RETRY_ATTEMPTS` — optional positive integer retry count for transient provider request failures; defaults to 3 when unset
- Provider API keys: `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `OPENAI_COMPATIBLE_API_KEY`, `ANTHROPIC_API_KEY`, `BASETEN_API_KEY`, `FIREWORKS_API_KEY`
- ChatGPT OAuth tokens (for the `openai-chatgpt` provider): `OPENAI_CHATGPT_ACCESS_TOKEN`, `OPENAI_CHATGPT_REFRESH_TOKEN`, `OPENAI_CHATGPT_EXPIRES_AT`, `OPENAI_CHATGPT_ACCOUNT_ID`, `OPENAI_CHATGPT_EMAIL`, `OPENAI_CHATGPT_PLAN`
- Connector OAuth credentials: `OPENWIKI_GMAIL_ACCESS_TOKEN`, `OPENWIKI_GMAIL_REFRESH_TOKEN`, `OPENWIKI_GOOGLE_CLIENT_ID`, `OPENWIKI_GOOGLE_CLIENT_SECRET`, `OPENWIKI_NOTION_MCP_ACCESS_TOKEN`, `OPENWIKI_NOTION_MCP_CLIENT_ID`, `OPENWIKI_NOTION_MCP_REFRESH_TOKEN`, `OPENWIKI_SLACK_USER_TOKEN`, `OPENWIKI_SLACK_CLIENT_ID`, `OPENWIKI_SLACK_CLIENT_SECRET`, `OPENWIKI_X_ACCESS_TOKEN`, `OPENWIKI_X_CLIENT_ID`, `OPENWIKI_X_CLIENT_SECRET`, `OPENWIKI_X_REFRESH_TOKEN`
- Base URLs: `ANTHROPIC_BASE_URL` (optional — routes the anthropic provider at an Anthropic-compatible endpoint other than the default API) and `OPENAI_COMPATIBLE_BASE_URL` (required by the openai-compatible provider, which has no default endpoint)
- Connector API keys: `TAVILY_API_KEY` for Web Search
- Optional LangSmith settings: `LANGSMITH_API_KEY`, `LANGCHAIN_PROJECT`, `LANGCHAIN_TRACING_V2`
- Optional OAuth callback settings: `OPENWIKI_OAUTH_CALLBACK_PORT` controls the
  local callback port, and `OPENWIKI_HTTPS_OAUTH_REDIRECT_URI` stores the
  Slack-only HTTPS callback URL created by `openwiki ngrok start`.

The loader merges those values into `process.env`, while preferring existing process-level values over file values. Deprecated keys (`OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT`) are skipped on load and removed on save.

Values containing newlines or carriage returns are serialized as double-quoted strings with `\n`, `\r`, `\\`, and `\"` escaped by `formatEnvValue()`, and unescaped on load by `parseEnvValue()`. Carriage return escaping is important on Windows, where multi-line env values can contain bare `\r` characters that would otherwise be silently stripped during round-trip serialization.

Slack OAuth can require an HTTPS redirect URL, so `openwiki ngrok start <url>`
saves `OPENWIKI_HTTPS_OAUTH_REDIRECT_URI`. Other connector OAuth flows, such as
X/Twitter and Gmail, ignore that HTTPS override and use the local loopback
callback `http://127.0.0.1:<port>/callback`.

Gmail OAuth saves a read-only access token and refresh token. After
`openwiki auth gmail`, the Google connector is ready for direct Gmail API
ingestion without an MCP transport. By default it queries `newer_than:1d` and
writes `gmail-messages.json` under `~/.openwiki/connectors/google/raw/<run-id>/`.

Web Search uses Tavily through LangChain. First-run onboarding asks for
`TAVILY_API_KEY`, stores it in `~/.openwiki/.env`, and writes configured search
queries to `~/.openwiki/connectors/web-search/config.json`.

Hacker News uses public read-only APIs and does not require credentials. The
connector can fetch top/new/best/show/ask/job feeds and configured search
queries.

`src/credentials.tsx` provides the interactive bootstrap flow when required:

- prompts for a provider (arrow-key selection menu),
- prompts for the provider's API key,
- prompts for a model choice (arrow-key selection from the provider's model list, or a custom model ID),
- optionally prompts for a LangSmith key,
- writes the results with restrictive file permissions,
- removes deprecated OpenAI-related environment variables when saving.

The setup flow runs for **all** interactive commands (chat, init, and update) when credentials are missing — not just chat. In non-interactive mode (no TTY or `--print`), missing provider keys produce an error instead of a prompt.

## First-run onboarding profile

After model setup, first-run onboarding lets the user choose one of five wiki
templates: Personal Work OS, AI Research Radar, Git Project Wiki, Social Media

- Market Briefing, or Engineering Memory. Users can also choose Custom. The
  template seeds the wiki scope prompt, and the user can edit it before saving.

Onboarding then walks through source connections for local Git repositories,
Notion, Gmail, X/Twitter, Web Search, and Hacker News. Non-secret setup
preferences are stored in `~/.openwiki/onboarding.json`:

- the selected template ID/name,
- which sources have been connected,
- optional per-source ingestion guidance,
- per-source cron expressions and plain-English schedule descriptions,
- macOS LaunchAgent paths when schedule installation succeeds,
- optional macOS `pmset` wake/sleep window metadata.

The user's global personal wiki scope/intent is stored as Markdown in
`~/.openwiki/INSTRUCTIONS.md` so it can be edited directly.

OAuth tokens and client secrets are not stored in this file. They remain in
`~/.openwiki/.env`.

## Local schedules

Source schedules are validated with `cron-parser` and described with
`cronstrue`. On macOS, OpenWiki installs simple cron schedules as user
LaunchAgents in `~/Library/LaunchAgents/com.openwiki.<source>.plist`. The plist
runs `openwiki --update --print` from the setup working directory and writes logs
under `~/.openwiki/logs/`.

LaunchAgent plists never embed secret values. Complex cron expressions that
cannot be represented directly as `StartCalendarInterval` are saved in the
onboarding profile with a warning instead of being installed inaccurately.

After saving a source cron, onboarding can also configure a Mac wake window with
`pmset`. OpenWiki computes a shared window across currently saved source
schedules: wake 2 minutes before the earliest supported schedule, then sleep 30
minutes after the latest supported schedule. The setup uses the macOS
administrator prompt because changing `pmset` repeat schedules is a system power
setting.

`pmset` is a single machine-level repeat schedule, not a per-source scheduler.
Setting it from OpenWiki may replace an existing repeat wake/sleep schedule. If
the Mac is closed, powered off, out of battery, or the cron expression cannot be
represented as a simple daily/weekly wake window, OpenWiki saves the source cron
and records a warning instead of installing an inaccurate power schedule.

Saved local schedules can be managed from the CLI:

- `openwiki cron list` shows saved connector schedules, launchd state, and the
  saved Mac wake window.
- `openwiki cron pause <source|all>` unloads the matching launchd job(s), keeps
  the cron metadata, and reconciles the shared `pmset` wake window.
- `openwiki cron resume <source|all>` reinstalls paused launchd job(s) from the
  saved cron metadata and reconciles the shared `pmset` wake window.
- `openwiki cron delete <source|all>` unloads the matching launchd job(s),
  removes the OpenWiki LaunchAgent plist(s), deletes only the schedule metadata,
  and reconciles the shared `pmset` wake window. It does not remove connector
  auth, connector config, raw data, or wiki content.

When pause or delete leaves no active OpenWiki schedules, OpenWiki cancels the
saved repeat `pmset` schedule and marks the saved wake window disabled.

## Provider resolution

`resolveConfiguredProvider()` in `src/constants.ts` determines the active provider:

1. If `OPENWIKI_PROVIDER` is set and valid, use it.
2. Otherwise, use the first available provider API key in this order: OpenAI, OpenAI-compatible, OpenRouter, Anthropic, Baseten, Fireworks, then NVIDIA.
3. Otherwise, fall back to `DEFAULT_PROVIDER` (`openai`) and its default model (`gpt-5.6-terra`).

`needsCredentialSetup()` in `src/credentials.tsx` checks whether the provider env var is valid and whether the provider's API key, a model ID (unless overridden), and a LangSmith key are all present. Any missing or invalid provider value triggers the interactive flow.

## Model and credential diagnostics

The env layer also produces diagnostics for the CLI UI. Those diagnostics report:

- where each credential came from (`process.env`, `~/.openwiki/.env`, both, or `unset`),
- whether the value is unset,
- the apparent length,
- a masked preview,
- warnings for suspicious formatting such as whitespace, newlines, quotes, or bracketed suffixes,
- invalid model IDs,
- invalid provider values.

Diagnostics cover all provider keys (including `OPENAI_CHATGPT_ACCESS_TOKEN` and related ChatGPT OAuth tokens), plus `OPENWIKI_PROVIDER`, `OPENWIKI_MODEL_ID`, `OPENWIKI_PROVIDER_RETRY_ATTEMPTS`, the base URLs (`ANTHROPIC_BASE_URL`, `OPENAI_COMPATIBLE_BASE_URL`), connector credentials, and `LANGSMITH_API_KEY`. This makes startup problems easier to diagnose without exposing secret values (non-secret values such as the provider, model ID, retry attempts, and base URLs are shown in full).

## Update metadata

After successful `init` or `update` runs where the `openwiki/` content changed, `src/agent/utils.ts` writes `openwiki/.last-update.json` with:

- `updatedAt`
- `command`
- `gitHead`
- `model`

The content-change check uses `createOpenWikiContentSnapshot()`, which hashes the `openwiki/` directory (excluding `.last-update.json`). If the hash is identical before and after the run, metadata is not written. This prevents scheduled update loops from updating the timestamp when no documentation changed.

Update runs use this metadata to build a change summary since the previous successful OpenWiki execution — preferring `gitHead` for a precise commit range, falling back to `updatedAt` for a time-based range.

## Scheduled CI workflows

The repository includes `examples/openwiki-update.yml` as a copyable GitHub Actions scheduled update workflow. It:

- runs on schedule (daily at 08:00 UTC) and on manual dispatch,
- checks out the repository,
- installs Node.js 22,
- installs OpenWiki globally,
- runs `openwiki code --update --print`,
- passes `OPENROUTER_API_KEY`, `OPENWIKI_MODEL_ID`, and `LANGSMITH_API_KEY` from GitHub secrets,
- opens a pull request with `peter-evans/create-pull-request` scoped to the `openwiki` directory.

The workflow is a good reference for automated maintenance. The repo also contains a `checks.yml` workflow for CI (lint/format checks).

The repository also includes `examples/openwiki-update.gitlab-ci.yml` as a copyable GitLab CI scheduled update job. It:

- runs from a scheduled pipeline or a manually triggered web pipeline,
- installs OpenWiki globally in a Node.js 22 container,
- runs `openwiki code --update --print`,
- skips the rest of the job when `openwiki/` did not change,
- commits changes to a generated `openwiki/update-$CI_PIPELINE_ID` branch,
- pushes that branch back to the GitLab project, and
- creates a merge request targeting the project's default branch through the GitLab API.

GitLab users should configure protected CI/CD variables for the model provider key, for example `OPENROUTER_API_KEY`, and `OPENWIKI_GITLAB_TOKEN`. The GitLab token needs permission to push a branch and create merge requests in the target project.

The repository also includes `examples/openwiki-update.bitbucket-pipelines.yml` as a copyable Bitbucket Pipelines scheduled update job. It:

- runs on a custom schedule or manual trigger,
- installs OpenWiki globally in a Node.js 22 container,
- runs `openwiki code --update --print`,
- commits changes to a generated `openwiki/update-$BITBUCKET_BUILD_NUMBER` branch,
- pushes that branch back to the Bitbucket repository, and
- creates a pull request targeting the default branch through the Bitbucket API.

Bitbucket users should configure repository variables for the model provider key (for example `OPENROUTER_API_KEY`) and `OPENWIKI_BITBUCKET_TOKEN`. The Bitbucket token needs write permission to push a branch and create pull requests in the target repository.

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
- `src/agent/openai-chatgpt-oauth.ts`
- `src/auth/oauth.ts`
- `src/auth/providers.ts`
- `src/auth/configure.ts`
- `src/auth/tokens.ts`
- `src/onboarding.ts`
- `src/schedules.ts`
- `src/code-mode.ts`
- `examples/openwiki-update.yml`
- `examples/openwiki-update.gitlab-ci.yml`
- `examples/openwiki-update.bitbucket-pipelines.yml`
- `README.md`
- Git evidence: commits `ceded10`, `f89b05d`, `8278c36`, `0fa1430`
