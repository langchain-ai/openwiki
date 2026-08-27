---
type: workflow
title: Onboarding and Setup
description: How OpenWiki's first-run setup selects a provider and model, captures credentials, chooses a run mode, and bootstraps code-mode repositories, plus the layout and permissions of the ~/.openwiki state directory.
tags: [onboarding, setup, credentials, code-mode, openwiki-home, configuration]
verified:
  - by: openwiki/0.3.3
    at: 2026-08-25T02:14:25.283Z
sources:
  - id: openwiki-source-a34c01da72fb3c9bee4f3cb9
    resource: repo://src/agent/openwiki-ignore.ts
  - id: openwiki-source-106c72a9cb6dd904077fc747
    resource: repo://src/cli/runners.ts
  - id: openwiki-source-d80f123259efa4712b198b63
    resource: repo://src/cli/startup.ts
  - id: openwiki-source-c2770ac037a7f4b0116a0dc5
    resource: repo://src/config/env.ts
  - id: openwiki-source-7d433875b0854d0b8b951be0
    resource: repo://src/config/openwiki-home.ts
  - id: openwiki-source-7c5ecb56558cc061dab24f9d
    resource: repo://src/generation/repository-run.ts
  - id: openwiki-source-85064d6a188fa56bcc282f11
    resource: repo://src/ingestion/code-mode.ts
  - id: openwiki-source-28a5ae6f5a5bb7466bd04868
    resource: repo://src/setup/credentials/constants.ts
  - id: openwiki-source-c35800ddf00768a1fa848d13
    resource: repo://src/setup/credentials/persistence.ts
  - id: openwiki-source-7388b63c6f928737a7109779
    resource: repo://src/setup/credentials/steps.ts
  - id: openwiki-source-7c7ce1305f8f14f43fec29de
    resource: repo://src/setup/credentials/use-init-setup.ts
  - id: openwiki-source-14d4f389b56575bb7afd1310
    resource: repo://src/setup/onboarding.ts
generated: { by: "openwiki/0.3.3", at: "2026-08-25T02:14:25.283Z" }
---

# Onboarding and Setup

OpenWiki's first run walks the operator through a short wizard that resolves a
model provider, collects the credentials that provider needs, chooses between the
two run modes (Personal vs. Code), captures a wiki brief, and — for code mode —
bootstraps the target repository. All non-secret onboarding state and all secret
credentials live under a single per-user state directory (`~/.openwiki` by
default). This page documents the setup flow, its persisted artifacts, and the
directory's contents and permission model.

Related concepts: [Model Providers](../concepts/model-providers.md),
[Two Modes](../concepts/two-modes.md). Related operations:
[CLI Reference](../operations/cli-reference.md),
[Configuration](../operations/configuration.md).

## The `~/.openwiki` state directory

The state directory root is resolved once at process start. By default it is
`~/.openwiki`, but the `OPENWIKI_CONFIG_DIR` environment variable overrides it;
the override supports a leading `~` (expanded to the home directory) that several
environments leave literal. When the override is unset the display path is shown
as the literal `~/.openwiki`, otherwise the resolved absolute path is shown.

`ensureOpenWikiHome()` creates the directory tree and enforces its permissions on
every access: the home directory and each managed subdirectory are created with
mode `0o700`, the home directory is `chmod`ed to `0o700` if it already existed,
and `restrictDirToCurrentUser` applies the Windows ACL equivalent so the
directory is owner-only on every platform.

The managed layout is:

```mermaid
flowchart TD
  Home["~/.openwiki (0o700)"] --> Env[".env (0o600, credentials)"]
  Home --> Onb["onboarding.json (0o600)"]
  Home --> Instr["INSTRUCTIONS.md (0o600, personal wiki brief)"]
  Home --> Conn["connectors/ (per-connector config, state, raw, logs)"]
  Home --> Hist["conversation_history/"]
  Home --> Wiki["wiki/ (local personal-mode wiki output)"]
  Home --> Skills["skills/"]
```

Layout of the `~/.openwiki` state directory and the mode of each managed entry.

`connectors/<id>` is created per connector by `ensureConnectorHome`, which also
validates the connector id against `^[a-z][a-z0-9-]{0,63}$` and creates `raw/`
and `logs/` subdirectories at `0o700`. Reads from a connector's `raw/` directory
are constrained by `resolveConnectorRawPath`, which rejects any relative path that
would escape the connector's raw directory.

## Credentials and the `.env` file

Provider credentials and model configuration are written to `~/.openwiki/.env`
(the env directory is the home directory itself). `saveOpenWikiEnv` merges an
update map into the existing file and persists it with the following invariants:

- Writes are serialized through an internal queue so concurrent saves cannot
  interleave, and a failed save resets the queue so later saves are not blocked
  behind a rejected promise.
- The file is written to a temp file in the same directory (`0o600`) and then
  atomically `rename`d into place, so a crash mid-write cannot truncate the
  existing credential file and lose saved tokens/keys.
- Empty values are dropped rather than persisted as `KEY=""`, so skipping an
  optional key (e.g. LangSmith) leaves it genuinely unset; this also self-heals
  empty values left by earlier writes.
- A key exported in the launch shell wins at runtime, so `saveOpenWikiEnv` does
  not mask a shell export in `process.env`; the saved value is only the fallback
  used when the shell variable is unset.

The wizard's persistence layer is split: `buildCredentialEnvUpdates` is a pure
function that computes which env keys to write from the values the wizard
collected (provider, primary credential, base URL, secret key, region, GCP
project/location, model id, reasoning effort, and LangSmith key), performing no
IO; the caller persists the result via `saveOpenWikiEnv`. The provider key is
written only when it differs from the current environment, so re-running setup
with the same provider does not churn the file. A LangSmith key toggles tracing:
a non-empty key also sets `LANGCHAIN_PROJECT=openwiki` and
`LANGCHAIN_TRACING_V2=true`, while a blank input sets `LANGCHAIN_TRACING_V2=false`
so tracing is explicitly disabled rather than silently left on.

## Setup wizard steps

The setup UI is a thin composition root (`InitSetup`) that renders a view driven
by a controller state machine. The steps that apply to a given provider and run
mode, in walk order, are produced by `orderedSetupSteps`: an optional run-mode
chooser, the provider selection, the provider's primary credential step, any
provider-specific steps (secret key, GCP project/location, base URL, region),
then the model step, the LangSmith step, and finally — only in code mode — a
`code-repo-confirm` step.

The primary credential step is chosen per provider by `credentialStep`: OAuth
providers use `oauth-login`, AWS-SDK providers have no in-wizard step (they are
handled via AWS credentials), external-CLI providers use `external-cli-auth`,
API-key providers use `api-key`, and keyless providers that require a GCP project
use `gcp-project`.

```mermaid
stateDiagram-v2
  [*] --> run_mode
  run_mode --> provider
  provider --> credential
  credential --> extra_provider_steps
  extra_provider_steps --> model
  model --> langsmith
  langsmith --> code_repo_confirm: code mode
  langsmith --> [*]: personal mode
  code_repo_confirm --> [*]
```

Ordered setup steps for code vs. personal mode as returned by orderedSetupSteps.

Two functions distinguish "which step to jump to" from "which steps exist".
`getInitialStep` is a skip-based waterfall that lands on the first unsatisfied
step (unless `walkAll`/`--init` forces starting at the top and walking every
applicable step even when already configured), whereas `orderedSetupSteps` and
`nextSetupStep` drive sequential forward navigation that can reach and re-edit an
already-satisfied step. `needsCredentialSetup` decides whether the wizard is
required at all: it returns true when the provider is invalid or missing any
credential/model/LangSmith input, and otherwise defers to whether onboarding is
complete for the mode.

## Onboarding config format and completion

Non-secret onboarding state is persisted as JSON at
`~/.openwiki/onboarding.json` (`OpenWikiOnboardingConfig`, `version: 1`). It
records `completedAt`, the run mode (`modeId`/`modeName`), configured source
instances, an ingestion schedule, optional macOS power-management settings, and
template metadata. `saveOpenWikiOnboardingConfig` writes it at mode `0o600` and
re-`chmod`s it to `0o600`. Reads go through `normalizeOnboardingConfig`, which
tolerates and repairs partial or legacy shapes: it accepts legacy `templateId`/
`templateName` as fallbacks for `modeId`/`modeName`, drops unknown connector ids,
migrates the legacy `sources` map into `sourceInstances`, lifts a per-source
schedule up to the top-level `ingestionSchedule`, and re-derives the legacy
`sources` map from the normalized instances.

The wiki brief (`wikiGoal`) is stored **outside** `onboarding.json`. On save the
config's `wikiGoal` is stripped from the JSON and written to a separate
`INSTRUCTIONS.md` file at `0o600`; on read it is re-attached by reading that file
back. Where `INSTRUCTIONS.md` lives depends on the mode (see below).

`isOnboardingComplete` treats onboarding as finished only when there is a
`completedAt`, a non-empty `wikiGoal`, and either the config is code mode or an
ingestion schedule is present. Synchronous variants read the state without async
IO: `isOpenWikiOnboardingCompleteSync` reads the personal-mode brief from
`~/.openwiki/INSTRUCTIONS.md`, while `isRepositoryCodeOnboardingCompleteSync`
first requires the config to be code mode and reads the brief from the target
repository instead.

## Code-mode repository bootstrap

In code mode the wiki brief is not stored in the home directory. When setup
completes for code mode, `saveRepositoryWikiInstructions` writes the brief to
`<repo>/openwiki/INSTRUCTIONS.md` (mode `0o644`, since it is committed alongside
the repo), and `onboarding.json` is saved with `wikiGoal` cleared. The target
repository defaults to the nearest ancestor of the working directory containing a
`.git` directory (`findNearestGitRepoRoot`), falling back to the current
directory when none is found.

Repository setup for a code-mode run is performed by `ensureCodeModeRepoSetup`,
invoked before both interactive/`--print` runs (in the CLI runner) and durable
repository runs (`beginRepositoryRun`). It:

- Refreshes the managed agent-instruction snippets in `AGENTS.md` and
  `CLAUDE.md`. Each file is created when missing and, when present, only the
  region between the `<!-- OPENWIKI:START -->` / `<!-- OPENWIKI:END -->` markers
  is replaced, so operator content outside the markers survives. Both files are
  prepared and validated before either is written, and malformed or duplicated
  markers abort the update with the file left unchanged. The `CLAUDE.md` snippet
  is deliberately minimal and just points to `AGENTS.md`.
- Creates the scheduled-update GitHub Actions workflow
  (`.github/workflows/openwiki-update.yml`) **only** when `createWorkflow` is set,
  which is the case only for the `init` command. `--update` and chat runs leave
  an existing workflow alone, and even under `init` the workflow is written only
  when it does not already exist, so operator customizations (fork guards, pinned
  actions, custom steps) are never silently overwritten.

The generated workflow runs `openwiki code --update --print` on a cron schedule
(default `0 8 * * *`), checks out full history so the update can diff against the
last documented commit, installs the pinned OpenWiki version, and opens a pull
request scoped to `openwiki`, `AGENTS.md`, `CLAUDE.md`, and the workflow file.
Its provider `env:` block is derived from the provider the operator configured
during setup (`createWorkflowProviderEnv`): secrets are wired through
`secrets.`, non-sensitive settings (base URL, project, region) through `vars.`,
and OAuth providers emit a comment noting that browser login has no unattended
equivalent instead of pinning a short-lived, rotated token.

Repository content the doc agent must not read or edit is governed by a
gitignore-style `.openwikiignore` file loaded via `OpenWikiIgnore.load`. Rules
are applied in file order with last-match-wins semantics (a later `!` rule can
re-include an excluded path), and matching is case-insensitive so an
alternate-cased spelling cannot bypass an exclusion on case-insensitive
filesystems.

## Non-interactive credential gate

For non-interactive runs (`--print` or no TTY) OpenWiki cannot open the wizard,
so `resolveStartupCommand` fails fast with an actionable error when the
configured provider is missing a required credential, telling the operator to run
in an interactive terminal to save credentials. Interactive chat likewise
requires a TTY. One exception exists: a clean `update --print` run that would be a
no-op can skip the credential requirement, because there is nothing to generate.
