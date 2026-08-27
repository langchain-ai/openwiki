---
type: operations-reference
title: Configuration and Environment
description: How OpenWiki loads, resolves, and persists configuration through environment variables and the ~/.openwiki state directory, including secret sanitization, atomic env writes, and provider/token/reasoning settings.
tags:
  [
    configuration,
    environment-variables,
    state-directory,
    secrets,
    providers,
    reasoning,
    operations,
  ]
verified:
  - by: openwiki/0.3.3
    at: 2026-08-25T02:14:25.283Z
sources:
  - id: openwiki-source-278e7e180eac811fc1a24f7a
    resource: repo://src/config/constants.ts
  - id: openwiki-source-c2770ac037a7f4b0116a0dc5
    resource: repo://src/config/env.ts
  - id: openwiki-source-7d433875b0854d0b8b951be0
    resource: repo://src/config/openwiki-home.ts
  - id: openwiki-source-f1dd0edb129e50f253618ff4
    resource: repo://src/config/reasoning.ts
  - id: openwiki-source-04a008dbe4969919f7141a55
    resource: repo://src/platform/diagnostics.ts
  - id: openwiki-source-27fbd70857f0fae28185fe91
    resource: repo://src/platform/windows-acl.ts
generated: { by: "openwiki/0.3.3", at: "2026-08-25T02:14:25.283Z" }
---

# Configuration and Environment

OpenWiki is configured almost entirely through environment variables. Provider
credentials, model selection, token limits, streaming toggles, and reasoning
effort are all read from `process.env`, with a persisted fallback file at
`~/.openwiki/.env`. This page describes where that state lives, how values are
loaded and saved, the precedence between the shell and the saved file, how
secrets are sanitized, and the key settings a reader needs to operate OpenWiki.

Related reading: [Model providers](../concepts/model-providers.md),
[CLI reference](./cli-reference.md), and [Onboarding](../workflows/onboarding.md).

## The state directory

All persistent OpenWiki state lives under a single home directory, resolved by
`resolveOpenWikiHomeDir`. By default this is `~/.openwiki`
(`path.join(os.homedir(), ".openwiki")`), but it can be relocated with the
`OPENWIKI_CONFIG_DIR` environment variable. A configured directory is
tilde-expanded manually (because `path.resolve` does not expand a leading `~`)
so values like `~/custom` that come from PowerShell, docker-compose, or a
hand-edited `.env` resolve correctly.

`ensureOpenWikiHome` creates the home directory and its subdirectories —
`connectors`, `conversation_history`, `wiki`, and `skills` — each with owner-only
`0o700` permissions. The persisted environment file lives at
`<home>/.env` (`openWikiEnvPath`), displayed to users as `~/.openwiki/.env`.

### Windows ACL handling

POSIX `0o700` intent does not translate to Windows, where `fs.chmod` only toggles
the read-only attribute and leaves ACLs untouched. To preserve owner-only access
on Windows, directory creation runs `restrictDirToCurrentUser`, which uses
`icacls` to grant full control to the current user and the well-known SYSTEM SID
(`*S-1-5-18`, referenced by SID so it resolves regardless of display language),
then removes inherited ACEs. The grant runs before the inheritance reset so a
failed grant can never lock the user out of the directory. It is best-effort by
design: it returns `false` instead of throwing so ACL tooling problems never
block a run, and it is a no-op on non-Windows platforms.

## Managed keys as the single source of truth

`MANAGED_ENV_KEYS` in `src/config/env.ts` lists every environment variable
OpenWiki reads or persists, in the exact order they are written to
`~/.openwiki/.env`. It is the single source of truth: both the credential
diagnostics list (`CREDENTIAL_DIAGNOSTIC_ENV_KEYS`) and the agent's debug-dump
key list (`DEBUG_ENV_KEYS`) are derived from it by filtering, so they cannot
silently drift out of sync when a new managed key is added. LangChain
project/tracing settings are managed but are not credentials, so they are
excluded from the diagnostics panel via `NON_CREDENTIAL_ENV_KEYS`.

## Loading and precedence

```mermaid
flowchart TD
  A["loadOpenWikiEnv"] --> B["captureShellEnv snapshot"]
  B --> C["readOpenWikiEnv from ~/.openwiki/.env"]
  C --> D["record savedEnvAtStartup on first load"]
  D --> E{"process.env already set for key"}
  E -- yes --> F["keep shell value"]
  E -- no --> G["seed process.env from saved file"]
```

Precedence when OpenWiki loads its persisted environment file.

`loadOpenWikiEnv` reads `~/.openwiki/.env` and copies each value into
`process.env` only when that key is not already set. This makes a shell export
win over the saved file at runtime: OpenWiki never overwrites a variable the user
exported in their shell. Deprecated keys (`OPENAI_ORG_ID`, `OPENAI_PROJECT`) are
skipped on load. Reading a non-existent file is not an error — `readOpenWikiEnv`
returns an empty map when the file is missing.

To reason about this precedence, OpenWiki captures two in-memory snapshots at
startup, both held in memory only and never persisted or logged:

- `captureShellEnv` records the shell's values for managed credential keys before
  any load or save wrote to `process.env`. It is idempotent — the first call
  wins — so a later load or save cannot capture values OpenWiki itself seeded.
  `getShellEnvValue` exposes this snapshot.
- `savedEnvAtStartup` records the file's values as of the first load, exposed via
  `getSavedEnvValue`. This lets the setup wizard pre-fill fields from the saved
  config rather than `process.env` (which a shell var may shadow), so editing
  config never accidentally captures a shell override.

## Saving: serialized, atomic, and shell-aware

`saveOpenWikiEnv` serializes all writes through a promise queue
(`saveOpenWikiEnvQueue`) so concurrent saves cannot interleave; a failed save is
swallowed in the queue chain so it does not permanently block later saves, while
the original caller still receives the error.

The locked save (`saveOpenWikiEnvLocked`) merges updates over the current file
contents, drops deprecated keys, and drops any key whose value is empty — an
empty value means "not set", so persisting `KEY=""` (which would later read back
as configured) is avoided, and this also self-heals empty values left by earlier
writes. It then ensures the directory exists with `0o700`, re-applies the mode,
and calls `restrictDirToCurrentUser`.

Writes are atomic: the new contents are written to a uniquely named temp file in
the same directory (mode `0o600`) and then `rename`d into place. A plain
`writeFile` would open the existing credential file with `O_TRUNC`, so a failure
mid-write (ENOSPC, crash, power loss) would truncate `~/.openwiki/.env` and lose
every saved token and key; the rename keeps the original intact until the new
contents are fully written.

After writing the file, `process.env` is updated to mirror the save — but a key
whose value came from a shell export at startup is left untouched, so an
in-process update never masks a shell variable that wins at runtime.

### File format

`formatEnv` writes managed keys first, in `MANAGED_ENV_KEYS` order, followed by
any other keys sorted alphabetically. Values are always double-quoted with
backslash, quote, newline, and carriage-return escaping. `parseEnv` reads the
file back: it ignores blank lines and `#` comments, accepts an optional
`export ` prefix, requires shell-style `UPPER_SNAKE_CASE` keys, and unescapes
double-quoted values.

## Key environment variables

### Provider and model selection

`OPENWIKI_PROVIDER` selects the provider and `OPENWIKI_MODEL_ID` selects the
model. When `OPENWIKI_PROVIDER` is unset, `resolveConfiguredProvider` infers the
provider from whichever credential is present, checking API keys in a fixed order
(`OPENAI_API_KEY`, then OpenAI-compatible, OpenRouter, Anthropic, Baseten,
Fireworks, Nebius, NVIDIA, then Bedrock access/secret keys) and falling back to
`DEFAULT_PROVIDER` (`openai`). Each provider declares its own credential env
variables and optional base-URL override in `PROVIDER_CONFIGS`; see
[Model providers](../concepts/model-providers.md) for the full registry.

### Token limits

`OPENWIKI_MAX_OUTPUT_TOKENS` is the provider-neutral per-request output cap,
parsed by `resolveMaxOutputTokens`, which accepts only a positive safe integer
(no fractions, exponents, or hex). `OPENWIKI_OPENROUTER_MAX_TOKENS` is a legacy
OpenRouter-specific cap retained for existing low-balance installations.
`resolveConfiguredMaxOutputTokens` picks between them: on OpenRouter runs the
legacy setting takes precedence when set, otherwise the provider-neutral setting
applies. The OpenRouter cap exists because, without it, OpenRouter's credit
pre-check budgets the model's full advertised output ceiling and rejects requests
with HTTP 402.

### Streaming and Responses API toggles

For the `openai-compatible` provider, two independent boolean toggles control
transport, each true only when the value trims to `"true"`:

- `OPENWIKI_OPENAI_COMPATIBLE_USE_RESPONSES_API`
  (`resolveOpenAiCompatibleUseResponsesApi`) routes generation through the OpenAI
  Responses API instead of chat completions.
- `OPENWIKI_OPENAI_COMPATIBLE_STREAMING` (`resolveOpenAiCompatibleStreaming`)
  forces the SSE streaming HTTP transport for every generation, for gateways that
  only serve streaming and otherwise fail silently with blank output.

A separate, distinct axis is `OPENWIKI_OPENAI_COMPATIBLE_STREAM_MESSAGES`
(`resolveOpenAiCompatibleStreamMessages`), which controls how LangGraph surfaces
a run in the TUI ("messages" stream mode) rather than the HTTP transport.

`OPENWIKI_STREAM_IDLE_TIMEOUT` sets the milliseconds to wait for the first or
next Bedrock stream chunk; `resolveStreamIdleTimeoutForProvider` applies it only
to the `bedrock` provider, and a value of `0` disables the stream watchdog
entirely (stalled streams may then hang indefinitely).

`OPENWIKI_PROVIDER_RETRY_ATTEMPTS` (`resolveProviderRetryAttempts`) sets provider
retry attempts, defaulting to `DEFAULT_PROVIDER_RETRY_ATTEMPTS` (3).

### Reasoning effort

`OPENWIKI_REASONING_EFFORT` selects a reasoning effort from
`REASONING_EFFORT_VALUES` (`none`, `low`, `medium`, `high`, `xhigh`, `max`).
`resolveReasoningConfig` returns `undefined` when the variable is unset, but
throws when it is set to an invalid value, when the selected provider/model has
no reasoning capability, or when the value is outside the values that
capability supports. Reasoning capability is declared per provider and model in
`REASONING_CAPABILITIES`, and each capability also carries the transport
(`responses-reasoning` or `chat-completions-reasoning-effort`) used to send it.

## Credential diagnostics

`getCredentialDiagnostics` produces one `CredentialDiagnostic` per key in
`CREDENTIAL_DIAGNOSTIC_ENV_KEYS`, comparing the file value against the
`process.env` value. Each entry reports its source — `process.env`, the env file
path, "process.env over &lt;file&gt;" when both are set, or `unset` — and a
masked preview. Non-secret settings (provider, model, token limits, base URLs,
region, Google project/location, and the boolean toggles) are shown verbatim;
true secrets are previewed as a short masked fragment (or all-asterisks for short
values). Diagnostics also surface per-key warnings, for example invalid provider,
invalid model ID, invalid token limits, invalid boolean, invalid reasoning
effort, credential whitespace/newline/quote issues, and a warning that the
Bedrock stream watchdog is disabled when the idle timeout is `0`.

## Secret sanitization

`sanitizeDiagnosticText` is the security boundary for anything shown to the user
or written to a log: every error message, header value, or provider response body
that could contain a credential must pass through it first. It redacts (1) the
exact values of secrets currently set in the environment, replacing each with
`[REDACTED:<KEY>]`, and (2) anything matching known key/token shapes — OpenAI and
OpenRouter `sk-…` keys, `Bearer …` headers, LangSmith `ls…` tokens, and the
"Incorrect API key provided: …" phrasing. `getErrorMessage` routes user-facing
errors through this sanitizer (with a friendlier message for provider HTTP 500s).

`isSecretLikeKey`, backed by the shared `SECRET_KEY_PATTERN_SOURCE`, is the
single source of truth for deciding whether an object key name looks
secret-bearing (matching `api_key`, `authorization`, `bearer`, `token`,
`secret`, `password`, `user_id`, or `cookie`); every redaction path — diagnostics,
OpenRouter response bodies, and MCP tool args/results — shares it, so a key
redacted by one path is redacted by all. `isAuthError` classifies failures as
credential rejections from HTTP 401/403 status and the already-redacted message,
driving whether the CLI shows the authentication "how to fix" panel.
