---
type: Operations Guide
title: Credentials and updates
description: Operational reference for OpenWiki local credential storage, onboarding metadata, provider diagnostics, and update tracking. Covers scheduling workflows and CI automation for maintaining OpenWiki content safely.
tags: [operations, credentials, updates, scheduling, ci]
---

# Credentials and updates

OpenWiki has four operational concerns that matter for both users and maintainers:

1. local credential storage in `~/.openwiki/.env`, and
2. persisted personal wiki instructions in `~/.openwiki/INSTRUCTIONS.md` (personal mode) or `<repo>/openwiki/INSTRUCTIONS.md` (code mode),
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

`src/config/env.ts` manages a private environment file under the user's home directory:

- directory: `~/.openwiki` (mode `0o700`)
- file: `~/.openwiki/.env` (mode `0o600`)

The file stores provider configuration and API keys:

- `OPENWIKI_PROVIDER` — the selected model provider
- `OPENWIKI_MODEL_ID` — the default model ID
- `OPENWIKI_PROVIDER_RETRY_ATTEMPTS` — optional positive integer retry count for transient provider request failures; defaults to 3 when unset
- `OPENWIKI_OPENROUTER_MAX_TOKENS` — optional positive integer cap on per-request output tokens for the openrouter provider, avoiding 402 credit-pre-check failures on low balances (non-secret, shown in diagnostics)
- Provider API keys: `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `OPENAI_COMPATIBLE_API_KEY`, `ANTHROPIC_API_KEY`, `BASETEN_API_KEY`, `FIREWORKS_API_KEY`, `GEMINI_API_KEY`, `NEBIUS_API_KEY`, `COPILOT_API_KEY` (the copilot provider can also authenticate via the GitHub CLI at runtime — see below)
- ChatGPT OAuth tokens (for the `openai-chatgpt` provider): `OPENAI_CHATGPT_ACCESS_TOKEN`, `OPENAI_CHATGPT_REFRESH_TOKEN`, `OPENAI_CHATGPT_EXPIRES_AT`, `OPENAI_CHATGPT_ACCOUNT_ID`, `OPENAI_CHATGPT_EMAIL`, `OPENAI_CHATGPT_PLAN`
- Connector OAuth credentials: `OPENWIKI_GMAIL_ACCESS_TOKEN`, `OPENWIKI_GMAIL_REFRESH_TOKEN`, `OPENWIKI_GOOGLE_CLIENT_ID`, `OPENWIKI_GOOGLE_CLIENT_SECRET`, `OPENWIKI_NOTION_MCP_ACCESS_TOKEN`, `OPENWIKI_NOTION_MCP_CLIENT_ID`, `OPENWIKI_NOTION_MCP_REFRESH_TOKEN`, `OPENWIKI_SLACK_USER_TOKEN`, `OPENWIKI_SLACK_CLIENT_ID`, `OPENWIKI_SLACK_CLIENT_SECRET`, `OPENWIKI_X_ACCESS_TOKEN`, `OPENWIKI_X_CLIENT_ID`, `OPENWIKI_X_CLIENT_SECRET`, `OPENWIKI_X_REFRESH_TOKEN`
- Base URLs: `ANTHROPIC_BASE_URL` (optional — routes the anthropic provider at an Anthropic-compatible endpoint other than the default API), `OPENAI_COMPATIBLE_BASE_URL` (required by the openai-compatible provider, which has no default endpoint), `OPENAI_BASE_URL` (optional — overrides the openai provider's default endpoint), `COPILOT_BASE_URL` (optional — overrides the copilot provider's default `https://api.githubcopilot.com`, useful for GHE.com data-residency hosts), `BASETEN_BASE_URL`, `FIREWORKS_BASE_URL`, `NVIDIA_BASE_URL` (optional overrides for those providers)
- `OPENWIKI_OPENAI_COMPATIBLE_USE_RESPONSES_API` — non-secret boolean opt-in that routes the openai-compatible provider through OpenAI's Responses API (`POST {baseURL}/responses`) instead of standard chat completions. Only the literal `true` (case-insensitive, trimmed) enables it; any other value keeps chat completions, and a non-`true`/`false` value surfaces an `invalid boolean` diagnostic warning. Resolved by `resolveOpenAiCompatibleUseResponsesApi()` in `src/config/constants.ts`.
- AWS Bedrock credentials: `BEDROCK_AWS_ACCESS_KEY_ID`, `BEDROCK_AWS_SECRET_ACCESS_KEY`, `BEDROCK_AWS_SESSION_TOKEN` (optional), `BEDROCK_AWS_REGION` (all supported by the bedrock provider via `authMethod: "aws-sdk"`, which also accepts standard AWS env vars — `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION`, `AWS_DEFAULT_REGION` — as well as `AWS_BEARER_TOKEN_BEDROCK`, `AWS_ROLE_ARN`, and `AWS_WEB_IDENTITY_TOKEN_FILE` for OIDC/web identity)
- Connector API keys: `TAVILY_API_KEY` for Web Search
- Google Cloud settings for the gemini-enterprise provider: `GOOGLE_CLOUD_PROJECT` (required to run gemini-enterprise), `GOOGLE_CLOUD_LOCATION` (optional, defaults to `global`), and `GOOGLE_APPLICATION_CREDENTIALS` (optional service-account key file path; never prompted for — Google Application Default Credentials handle auth)
- Optional LangSmith settings: `LANGSMITH_API_KEY`, `LANGCHAIN_PROJECT`, `LANGCHAIN_TRACING_V2`
- Optional OAuth callback settings: `OPENWIKI_OAUTH_CALLBACK_PORT` controls the
  local callback port, and `OPENWIKI_HTTPS_OAUTH_REDIRECT_URI` stores the
  Slack-only HTTPS callback URL created by `openwiki ngrok start`.
- Telemetry settings: `OPENWIKI_TELEMETRY_DISABLED` or `DO_NOT_TRACK` (opt out of anonymous usage telemetry), `OPENWIKI_SCHEDULED` (marks a run as CI/scheduled so it is sent under a sentinel id that does not inflate human install counts)

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

`src/setup/credentials.tsx` (thin re-export over `src/setup/credentials/` modules: `steps.ts`, `view.tsx`, `use-init-setup.ts`, `persistence.ts`, `format.ts`, `constants.ts`, `types.ts`) provides the interactive bootstrap flow when required:

- prompts for a provider (arrow-key selection menu),
- prompts for the provider's API key (skipped for the gemini-enterprise provider, which prompts for a required Google Cloud project ID and an optional location instead; skipped for the bedrock provider, which prompts for AWS access key ID, secret access key, and region instead),
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
Notion, Gmail, X/Twitter, Web Search, Hacker News, and the generic Custom MCP
source (configured via `~/.openwiki/connectors/custom-mcp/config.json` after
setup). Non-secret setup preferences are stored in `~/.openwiki/onboarding.json`:

- the selected template ID/name,
- which sources have been connected,
- optional per-source ingestion guidance,
- per-source cron expressions and plain-English schedule descriptions,
- macOS LaunchAgent paths when schedule installation succeeds,
- optional macOS `pmset` wake/sleep window metadata.

The user's global personal wiki scope/intent is stored as Markdown in
`~/.openwiki/INSTRUCTIONS.md` so it can be edited directly.

In **code mode**, the wiki brief is stored at the repository level as
`<repo>/openwiki/INSTRUCTIONS.md` instead of the global file.
`saveRepositoryWikiInstructions()` in `src/setup/onboarding.ts` writes the brief
there during code-mode onboarding, and `isRepositoryCodeOnboardingCompleteSync()`
checks for its presence when deciding whether onboarding is complete. This
ensures every new repository gets a proposed default wiki brief even when the
global onboarding profile is already complete. The agent prompt treats
`/openwiki/INSTRUCTIONS.md` as user-authored control metadata — it reads it
for scope and priorities but does not rewrite it during routine wiki
maintenance.

OAuth tokens and client secrets are not stored in these files. They remain in
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

`resolveConfiguredProvider()` in `src/config/constants.ts` determines the active provider:

1. If `OPENWIKI_PROVIDER` is set and valid, use it.
2. Otherwise, use the first available provider API key in this order: OpenAI, OpenAI-compatible, OpenRouter, Anthropic, Baseten, Fireworks, Nebius, NVIDIA, then Bedrock.
3. Otherwise, fall back to `DEFAULT_PROVIDER` (`openai`) and its default model (`gpt-5.6-terra`).

The copilot provider is selectable but never auto-detected — its credential comes from the GitHub CLI at runtime, so `resolveConfiguredProvider()` does not probe for it.

`needsCredentialSetup()` in `src/setup/credentials.tsx` checks whether the provider env var is valid and whether the provider's required credentials (its API key, or `GOOGLE_CLOUD_PROJECT` for gemini-enterprise — via `getMissingProviderEnvKey()` in `src/config/constants.ts`), a model ID (unless overridden), and a LangSmith key are all present. Any missing value or invalid provider triggers the interactive flow.

After the provider and model ID resolve, `resolveRunConfig()` in `src/agent/index.ts` validates the selected model's availability via `getSelectedModelAvailability()` in `src/model-availability.ts`. For the `openai` provider with an API key and the default endpoint, it queries the OpenAI Models API and aborts with a clear message when the model is not exposed to the configured credentials; every other case (non-OpenAI providers, custom endpoints, missing key, or lookup failure) proceeds as `unknown` so a catalogue lookup failure never blocks inference.

## Model and credential diagnostics

The env layer also produces diagnostics for the CLI UI. Those diagnostics report:

- where each credential came from (`process.env`, `~/.openwiki/.env`, both, or `unset`),
- whether the value is unset,
- the apparent length,
- a masked preview,
- warnings for suspicious formatting such as whitespace, newlines, quotes, or bracketed suffixes,
- invalid model IDs,
- invalid provider values,
- invalid `OPENWIKI_OPENROUTER_MAX_TOKENS` values.

Diagnostics cover all provider keys (including `OPENAI_CHATGPT_ACCESS_TOKEN` and related ChatGPT OAuth tokens), plus `OPENWIKI_PROVIDER`, `OPENWIKI_MODEL_ID`, `OPENWIKI_PROVIDER_RETRY_ATTEMPTS`, the base URLs (`ANTHROPIC_BASE_URL`, `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_BASE_URL`), the Google Cloud settings (`GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS`), the AWS Bedrock settings (`BEDROCK_AWS_ACCESS_KEY_ID`, `BEDROCK_AWS_SECRET_ACCESS_KEY`, `BEDROCK_AWS_REGION`), connector credentials, and `LANGSMITH_API_KEY`. This makes startup problems easier to diagnose without exposing secret values (non-secret values such as the provider, model ID, retry attempts, base URLs, and the Google Cloud settings are shown in full — the service-account key _path_ is not a secret, though the file it points to is).

## Update metadata

After `init` or `update` runs where the `openwiki/` content changed, `src/agent/utils.ts` writes `openwiki/.last-update.json` with:

- `updatedAt`
- `command`
- `gitHead`
- `model`
- `status` — `"complete"` (default) or `"interrupted"`

The content-change check uses `createOpenWikiContentSnapshot()`, which hashes the `openwiki/` directory (excluding `.last-update.json`). If the hash is identical before and after the run, metadata is not written. This prevents scheduled update loops from updating the timestamp when no documentation changed.

### Interrupted runs

When a run fails mid-stream, the catch block in `src/agent/index.ts` still calls `persistRunMetadataIfChanged()` with `status: "interrupted"` so that already-generated content stays diffable by future updates. Without this, a crashed run would be indistinguishable from a completed one — the next update would see a clean worktree with an unchanged git head and skip as a no-op, treating a possibly partial wiki as current.

A rejection that escapes every catch (for example a subagent error surfacing on the microtask queue during streaming) is caught by the process-wide crash guard in `src/agent/crash-guard.ts`, installed once at CLI startup. `handleFatal()` records the crash to telemetry and stamps the run `interrupted` post-mortem before exiting non-zero, so the next scheduled update still retries instead of skipping against a half-written wiki.

`getUpdateNoopStatus()` checks `lastUpdate.status` before skipping: if it is `"interrupted"`, the update is not skipped. Metadata written by older versions (no `status` field) is treated as `"complete"`, so upgrades do not force a spurious re-run. A completed retry that changes no content still rewrites the metadata to clear a leftover interrupted status, so the no-op skip recovers instead of re-running forever.

Update runs use this metadata to build a change summary since the previous successful OpenWiki execution — preferring `gitHead` for a precise commit range, falling back to `updatedAt` for a time-based range.

## Ignoring paths with `.openwikiignore`

A `.openwikiignore` file at the repository root keeps generated docs from reading or describing private, generated, or irrelevant paths. It is enforced as a **read boundary** during the run, not just a generation hint.

Syntax is gitignore-compatible (`src/agent/openwiki-ignore.ts`): comments (`#`), blank lines, `*` and `**` globs, `?` single-char, leading-`/` anchoring to the repo root, trailing-`/` directory scoping, and `!` negation with last-match-wins ordering.

```gitignore
secrets/
*.log
!logs/keep.log
```

Enforcement and bounds:

- The compiled `OpenWikiIgnore` ruleset is threaded through the agent backend, prompt, and run context as one cohesive object (`src/agent/docs-only-backend.ts`). When rules are active, filesystem tools (`read_file`, `write_file`, `edit_file`, raw reads) hard-deny any path the ruleset excludes, and shell `execute` is restricted to a small allowlist of maintenance commands so ignored paths cannot be reached via the shell.
- Paths are canonicalized (`normalizeIgnorePath`) before matching, so equivalent spellings such as `./secrets/x`, `secrets/../secrets/x`, or backslash variants cannot slip past an anchored rule. Matching is case-insensitive (`/iu`) to close a bypass on case-insensitive filesystems where `Secrets/token.txt` and `secrets/token.txt` resolve to the same file.
- The agent prompt is told the run has `.openwikiignore` rules and that matching paths are out of scope, and is directed to use `ls`, `read_file`, `glob`, and `grep` (which keep exclusions enforced) instead of shell-based discovery. When `.openwikiignore` is active, the prompt's git-history hint tells the agent history is unavailable through the shell and to rely on allowed source files and tests.
- This is a read boundary, not a topic-suppression guarantee: ignored paths are never read, scanned, or reproduced, but the agent may still infer an ignored area from other allowed evidence such as tests, the README, or commit messages.

## Anonymous usage telemetry

OpenWiki collects anonymous, per-machine usage telemetry via PostHog (`src/telemetry/`). The system emits a single `openwiki_run` event per run with mode (code/personal), provider, outcome (success/failure), latency, environment, configured connectors, and a `build_channel` stamp. Telemetry can be disabled by setting `OPENWIKI_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`.

CI and scheduled runs are detected via `ci-info` (or `OPENWIKI_SCHEDULED=1`) and sent under a sentinel distinct id per provider rather than the machine's install id, so ephemeral CI runners do not inflate human install counts. The install id is stored at `~/.openwiki/install-id` and a one-time disclosure notice is shown on first run (`src/telemetry/config.ts`). Telemetry never stalls a run — the send and client shutdown are bounded by a 3-second flush timeout (`src/telemetry/config.ts`).

### Build channel stamping

Every event carries a `build_channel` property (`"official"` or `"community"`) baked into the build so fork-originated telemetry can be filtered from the official-release signal. The committed default in `src/telemetry/gates.ts` is `"community"`; the upstream release pipeline rewrites that one `BUILD_CHANNEL` assignment to `"official"` via `scripts/stamp-build-channel.cjs` (driven by the `OPENWIKI_BUILD_CHANNEL` env var set in `.github/workflows/release.yml`), so only npm-published upstream builds report `"official"` and every fork, local build, and source/dev run reports `"community"`. The stamp is fail-safe: an unset or unrecognized value always resolves to `"community"`, so an unexpected env value can never mint an `"official"` build, and the stamp throws if the expected single `BUILD_CHANNEL` assignment is not present exactly once (so a drifted file fails the release loudly instead of silently publishing an unstamped build). The rewrite is ephemeral in CI (a throwaway checkout that is never committed back), so the committed source stays `"community"`. The stamp runs inside the `pnpm release` script (publish path only, before `tsc`), never on the version-PR path.

### Error classification and fingerprinting

Failure events are classified by walking an unwrap chain (`unwrapErrorChain()`, bounded at 32 links, cycle-safe) so a provider error hidden inside a tool-error wrapper or `AggregateError` is recovered instead of collapsing into the residual `agent_error` bucket. The origin-tag read is itself a chain walk: `readErrorOrigin()` mirrors `classifyError()` and returns the first link whose tag names an owned family (class + detail + throw-site stage), falling back to the nearest stage-only tag — so an owned error re-wrapped by a framework keeps its class instead of decaying to `agent_error`. The one override is `build_error/stream_open`: that stage is the first provider round trip, so a failure there carrying a provider signal (the raw classifier already naming it `provider_error`, or an HTTP status on the chain paired with any non-residual class) is a disguised provider error and the raw classification wins over the tag, landing the failure on the provider instead of being counted as our build bug. The residual `agent_error` bucket carries no fixed detail; its `error_detail` is the innermost error's own allowlisted name (`innermostErrorName()`), read from both `.name` (which a framework like LangChain's `MiddlewareError` copies up from the inner error) and `constructor.name`, walking to the deepest link so a framework envelope does not collapse every distinct root cause to one name. The identifier gate (`isSafeErrorIdentifier()` in `src/telemetry/taxonomy.ts`) allows only a bare ASCII identifier (letters/digits with single interior underscores, ≤64 chars); anything else is dropped so the anonymity envelope stays closed. The `errorName` field was removed — the residual bucket's signal now travels in `error_detail` — so every failure class reports a single shared detail property.

## Scheduled CI workflows

During `openwiki code --init`, `src/ingestion/code-mode.ts` also creates `.github/workflows/openwiki-update.yml` in the target repository if it does not already exist. On `--update` and chat runs, an existing workflow file is preserved verbatim so repo-specific customizations (fork guards, pinned actions, custom steps) are never silently overwritten. AGENTS.md and CLAUDE.md snippets are refreshed in place on every code-mode run using `<!-- OPENWIKI:START -->` / `<!-- OPENWIKI:END -->` markers. The two files now carry distinct managed content: AGENTS.md holds the full OpenWiki agent-instruction snippet (the canonical source), while CLAUDE.md holds a minimal pointer that links to `AGENTS.md`, so Claude Code — which reads CLAUDE.md at startup — is routed to the single source of truth rather than receiving a duplicated copy that can drift (#640).

The generated workflow's `env:` block is derived from the provider the operator configured during setup (`createWorkflowProviderEnv()` in `src/ingestion/code-mode.ts`), so a freshly created workflow authenticates the actual configured provider instead of shipping a fixed OpenRouter block whose first scheduled run fails on a secret the repo was never told about. Secrets go through `secrets.<KEY>` and non-sensitive settings (endpoint, project, region) through `vars.<KEY>`; `OPENWIKI_MODEL_ID` is quoted (JSON-stringified) because model IDs are not all plain YAML scalars — a Cloudflare Workers AI ID leading with `@` is a reserved YAML indicator that fails to parse unquoted. OAuth/browser-login providers (like `openai-chatgpt`) emit a comment instead of a secret, because their access token is short-lived and refreshed in place, so pinning it would break on the first rotation. Bedrock emits no preset model ID because entitlements are account- and region-specific. The provider env derivation is covered by `test/ingestion/code-mode.test.ts` ("authenticates the provider the operator configured", "emits non-secret provider settings as repository variables", "pairs both AWS credentials and the region for Bedrock", "does not pin a rotating browser-login token as a secret", "quotes the model ID so reserved YAML characters survive").

The repository includes `examples/openwiki-update.yml` as a copyable GitHub Actions scheduled update workflow. It:

- runs on schedule (daily at 08:00 UTC) and on manual dispatch,
- checks out the repository with `fetch-depth: 0` (full history) so `openwiki code --update` can diff HEAD against the commit it last documented — a shallow clone hides that commit and the update runs against an empty change summary,
- installs Node.js 22,
- installs OpenWiki globally,
- runs `openwiki code --update --print`,
- passes `OPENROUTER_API_KEY`, `OPENWIKI_MODEL_ID`, and `LANGSMITH_API_KEY` from GitHub secrets,
- opens a pull request with `peter-evans/create-pull-request` scoped to the `openwiki` directory.

The workflow is a good reference for automated maintenance. The repo also contains a `checks.yml` workflow for CI (lint/format checks).

The repository also includes `examples/openwiki-update.gitlab-ci.yml` as a copyable GitLab CI scheduled update job. It:

- runs from a scheduled pipeline or a manually triggered web pipeline,
- sets `GIT_DEPTH: "0"` (full clone) so `openwiki code --update` can diff HEAD against the last-documented commit — GitLab's default shallow clone hides that commit,
- installs OpenWiki globally in a Node.js 22 container,
- runs `openwiki code --update --print`,
- skips the rest of the job when `openwiki/` did not change,
- commits changes to a generated `openwiki/update-$CI_PIPELINE_ID` branch,
- pushes that branch back to the GitLab project, and
- creates a merge request targeting the project's default branch through the GitLab API.

GitLab users should configure protected CI/CD variables for the model provider key, for example `OPENROUTER_API_KEY`, and `OPENWIKI_GITLAB_TOKEN`. The GitLab token needs permission to push a branch and create merge requests in the target project.

The repository also includes `examples/openwiki-update.bitbucket-pipelines.yml` as a copyable Bitbucket Pipelines scheduled update job. It:

- runs on a custom schedule or manual trigger,
- clones with `depth: full` so `openwiki code --update` can diff HEAD against the last-documented commit — Bitbucket's default shallow clone hides that commit,
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
- When adding a provider, update `managedEnvKeys` in `src/config/env.ts` so the env file is formatted correctly and diagnostics cover the new key. Providers without an API key (like gemini-enterprise) declare their required env keys in `PROVIDER_CONFIGS` (e.g. `projectEnvKey`) and are gated by `getMissingProviderEnvKey()`. Providers with a paired secret and region (like bedrock) use `secretKeyEnvKey` and `regionEnvKey` with `requiresRegion: true`. External-CLI-auth providers (like copilot) declare `authMethod: "external-cli"` and `externalCliAuthAdapter`; the CLI login flow is handled in `src/auth/external-cli-auth.ts`, and the token is never persisted to `~/.openwiki/.env`. AWS SDK providers (like bedrock) declare `authMethod: "aws-sdk"` and delegate credential resolution to the AWS SDK chain.
- The content-snapshot check means CI runs that produce no changes will not update `.last-update.json` or open a PR with metadata-only changes.
- Scheduled update workflows must fetch full history (`fetch-depth: 0` for GitHub Actions, `GIT_DEPTH: "0"` for GitLab CI, `clone: depth: full` for Bitbucket). A shallow clone hides the commit recorded in `.last-update.json`, so `openwiki code --update` cannot build a change window and runs against an empty summary.
- The generated GitHub Actions workflow's `env:` block is provider-aware: `createWorkflowProviderEnv()` in `src/ingestion/code-mode.ts` derives it from the configured provider, routing secrets through `secrets.<KEY>` and non-sensitive settings through `vars.<KEY>`, quoting `OPENWIKI_MODEL_ID`, and emitting a comment for browser-login providers. If you change provider config fields, keep `createWorkflowProviderEnv()` and `test/ingestion/code-mode.test.ts` in sync so a freshly created workflow still authenticates the operator's provider.
- Interrupted runs write `status: "interrupted"` so the next update retries. If metadata semantics change, keep `getUpdateNoopStatus()` and `persistRunMetadataIfChanged()` in sync so the interrupted/complete lifecycle is preserved.
- The `build_channel` stamp (`scripts/stamp-build-channel.cjs`) targets exactly one `const BUILD_CHANNEL: BuildChannel = "…"` assignment in `src/telemetry/gates.ts`. Renaming that line, splitting it, or changing its formatting breaks the regex and fails the release loudly (`test/stamp-build-channel.test.ts`). Keep the committed value `"community"`; only the upstream release pipeline (`.github/workflows/release.yml`) sets `OPENWIKI_BUILD_CHANNEL=official`. A drifted `gates.ts` that no longer matches the assignment pattern will throw instead of silently publishing an unstamped build.

## Source map

- `src/config/env.ts`
- `src/setup/credentials.tsx` (re-exports `src/setup/credentials/`)
- `src/config/constants.ts`
- `src/agent/utils.ts`
- `src/agent/index.ts`
- `src/model-availability.ts`
- `src/agent/openai-chatgpt-oauth.ts`
- `src/auth/external-cli-auth.ts`
- `src/platform/diagnostics.ts`
- `src/telemetry/`
- `scripts/stamp-build-channel.cjs`
- `.github/workflows/release.yml`
- `src/auth/oauth.ts`
- `src/auth/oauth-discovery.ts`
- `src/auth/providers.ts`
- `src/auth/configure.ts`
- `src/auth/tokens.ts`
- `src/setup/onboarding.ts`
- `src/scheduling/schedules.ts`
- `src/ingestion/code-mode.ts`
- `src/agent/openwiki-ignore.ts`
- `src/agent/docs-only-backend.ts`
- `src/agent/prompt.ts`
- `examples/openwiki-update.yml`
- `examples/openwiki-update.gitlab-ci.yml`
- `examples/openwiki-update.bitbucket-pipelines.yml`
- `README.md`
