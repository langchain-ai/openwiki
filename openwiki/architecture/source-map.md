---
type: architecture-map
title: Source Map
description: Maps the OpenWiki /src directory to its owned subsystems, giving each one a responsibility and its principal entry files, and identifies the largest, most central files that anchor agent execution, configuration, and repository generation.
tags: [source-map, architecture, subsystems, entrypoints, src-layout]
sources:
  - id: openwiki-source-a953060a04ccefcf777de48e
    resource: repo://src/agent/index.ts
  - id: openwiki-source-6cb3236b8c1412a26d832fcf
    resource: repo://src/agent/repository-runner.ts
  - id: openwiki-source-69abc6f0f641147820a274bc
    resource: repo://src/agent/utils.ts
  - id: openwiki-source-239b2968fb2bcd073e89cedc
    resource: repo://src/claims/brains/code/runtime.ts
  - id: openwiki-source-2b28ddc861d155a44b3cc432
    resource: repo://src/claims/brains/code/store.ts
  - id: openwiki-source-75ba41da829774fe72b7a0af
    resource: repo://src/claims/evidence/repository/resolver.ts
  - id: openwiki-source-5c43e3fe562cf274dd6a5564
    resource: repo://src/cli/cli.tsx
  - id: openwiki-source-278e7e180eac811fc1a24f7a
    resource: repo://src/config/constants.ts
  - id: openwiki-source-3632bcf6292cc01fef69c5b7
    resource: repo://src/connectors/registry.ts
  - id: openwiki-source-1197594de038075f3570340c
    resource: repo://src/generation/page-jobs.ts
  - id: openwiki-source-674d6e5badef7368ab04f064
    resource: repo://src/generation/page-manifest.ts
  - id: openwiki-source-7c5ecb56558cc061dab24f9d
    resource: repo://src/generation/repository-run.ts
  - id: openwiki-source-080c4525024a9b689e361cbb
    resource: repo://src/generation/run-state.ts
  - id: openwiki-source-c6189f89b3f67d0cbf87739f
    resource: repo://src/ingestion/ingestion.ts
  - id: openwiki-source-58835b77ce38a0dd1fed8d09
    resource: repo://src/integrations/core/session-manager.ts
  - id: openwiki-source-eab9328975981f427c4218d0
    resource: repo://src/integrations/mcp/server.ts
  - id: openwiki-source-1324a62ac93d0625148b498e
    resource: repo://src/mermaid/dom-shim.ts
  - id: openwiki-source-4fbeebe90bb8c6910ecd1b3d
    resource: repo://src/mermaid/fences.ts
  - id: openwiki-source-3a971b24f14be56fa16b8e4b
    resource: repo://src/mermaid/validate.ts
  - id: openwiki-source-54432f9303757678a104d85f
    resource: repo://src/okf/frontmatter.ts
  - id: openwiki-source-2f1e489d53c52a0582582659
    resource: repo://src/platform/fs-errors.ts
  - id: openwiki-source-c923e23504de7a6af7799a24
    resource: repo://src/scheduling/schedules.ts
  - id: openwiki-source-a1d0931b37e6e9efdee37e97
    resource: repo://src/telemetry/index.ts
  - id: openwiki-source-d92f623adbf6b31c3542d58d
    resource: repo://src/visualize/graph.ts
  - id: openwiki-source-4d856d692c32be213c8c46b4
    resource: repo://src/visualize/server.ts
generated: { by: "openwiki/0.4.3", at: "2026-08-28T03:39:43.412Z" }
verified:
  - by: openwiki/0.4.3
    at: 2026-08-28T03:39:43.412Z
---

# Source Map

This page maps the `/src` tree to the subsystems it owns. It is organized by
responsibility, not as a file listing: each subsystem gets a one-line role and
its principal entry file(s). Use it to find where a concern lives before diving
into a subsystem's own page.

Related reading: [architecture overview](/openwiki/architecture/overview.md),
[agent runtime](/openwiki/architecture/agent-runtime.md),
[grounded claims](/openwiki/concepts/grounded-claims.md), and
[connectors](/openwiki/integrations/connectors.md).

## The central files

Three files carry a disproportionate share of the system and are worth knowing
before anything else.

- **`src/agent/index.ts`** (the largest source file) owns the LLM agent surface.
  It builds and runs the OpenWiki agent (`runOpenWikiAgent`,
  `createOpenWikiAgent`), resolves and constructs the chat model across every
  supported provider (`resolveModelId`, `createModel`), manages the LangGraph
  checkpoint thread and its history (`createOpenWikiThreadId`,
  `pruneCheckpointHistory`, `resolveCheckpointTarget`), and parses streamed
  agent events into `OpenWikiRunEvent`s (`parseStreamEvent`,
  `parseAgentStreamChunk`).
- **`src/config/constants.ts`** is the single large registry of stable strings:
  the `openwiki` directory name and the page-manifest/update-metadata paths, plus
  the provider environment-variable key names and defaults for every supported
  provider (`OPENAI_API_KEY_ENV_KEY`, `ANTHROPIC_API_KEY_ENV_KEY`, Bedrock/Vertex,
  Gemini, OpenRouter, Baseten, Copilot, Fireworks, Nebius, NVIDIA, and the
  connector OAuth keys) and the `OpenWikiProvider` union. Nearly every subsystem
  imports its identifiers from here.
- **`src/generation/repository-run.ts`** owns the repository-generation
  lifecycle. It drives the plan-then-page workflow with `beginRepositoryRun`,
  `submitRepositoryPlan`, `nextRepositoryPage`, `submitRepositoryPage`, and
  `finishRepositoryRun`, wiring together the run state, claims runtime, wiki
  finalizer, and OKF frontmatter validation — including deterministic
  frontmatter repair (`repairPersistedFile`) before a page job is accepted. It
  also owns the skip-failed-page-workers path: `captureRepositoryPageSnapshot`
  records the pending page and its claims sidecar before a worker runs,
  `skipRepositoryPage` rolls a failed worker back (restoring the page markdown
  and sidecar, marking the job `skipped`), and `restoreRepositoryPageMarkdown`
  re-applies the snapshot during `finishRepositoryRun` for every skipped job.

## Subsystems

### agent — LLM agent construction and repository authoring loop

Owns model/provider wiring, the agent tool loop, and the machinery that turns a
run into wiki pages. Principal entry: `src/agent/index.ts`. Supporting owners
include `src/agent/repository-runner.ts` (the native plan/page tool loop that
calls into `generation/repository-run.ts`), `src/agent/utils.ts` (run-context
construction, content/source snapshots, and update-metadata persistence shared
by the generation lifecycle), `src/agent/docs-only-backend.ts`
(the sandboxed shell/filesystem backend), the OKF and translation middleware
(`okf-middleware.ts`, `translation-middleware.ts`), the prompt builders
(`prompt.ts`, `repository-prompts.ts`), read-boundary enforcement
(`openwiki-ignore.ts`), wiki post-processing (`wiki-finalizer.ts`,
`wiki-link-validator.ts`, `wiki-replacement.ts`), and the ChatGPT/Vertex auth
surfaces (`openai-chatgpt-oauth.ts`, `vertex-surface.ts`).
`runNativeRepositoryGeneration` drives the full loop: it begins the run, runs
the planning agent, then calls `runPendingPageAgents` to spawn one fresh
shell-free worker per pending page, collecting skipped-page snapshots and
passing them to `finishRepositoryRun`. On a worker that exits without
submitting, `runPageAgent` captures a `RepositoryPageSnapshot` via
`captureRepositoryPageSnapshot`, calls `skipRepositoryPage` to restore the
page and mark it `skipped`, collects those snapshots, and passes them to
`finishRepositoryRun` so skipped pages are reconsidered on the next update.

### generation — repository run lifecycle and page jobs

Orchestrates a full repository wiki build. Principal entry:
`src/generation/repository-run.ts`. `src/generation/run-state.ts` owns the
durable on-disk checkpoint (`.run.json`, schema-versioned, with `planning`/
`generating` phases and `pending`/`skipped`/`complete` page-job statuses) so
runs resume after interruption. `src/generation/page-jobs.ts` builds the plan
(`createRepositoryPlan`) and replaces per-page claims (`replacePageClaims`).
`src/generation/page-manifest.ts` owns the committed page-correctness ledger
(`openwiki/.page-manifest.json`, schema-versioned), recording each completed
page's source fingerprint, page version, and producer provenance.
`src/generation/errors.ts` defines `RepositoryRunError`. The lifecycle's
snapshot/skip/restore operations (`captureRepositoryPageSnapshot`,
`skipRepositoryPage`, `restoreRepositoryPageMarkdown`) let a failed page worker
be rolled back to its pre-work state and marked `skipped` rather than failing
the whole run; `finishRepositoryRun` requires a snapshot for every skipped job
and re-applies those snapshots before finalizing.

### claims — grounded-claim persistence and evidence resolution

Owns the grounded-claims model: strict per-page claim sidecars and the evidence
that backs them. `src/claims/brains/code/runtime.ts` (`prepareClaimsRuntime`)
assembles process-local claims state used by a repository run;
`src/claims/brains/code/store.ts` (`ClaimsStore`) validates and persists claim
sidecars with a schema version; `session.ts` inspects and replaces page claims;
`preflight.ts` computes stable grounding issues. `src/claims/core/` holds
mutations, error types, and the resolver cache. `src/claims/evidence/repository/`
resolves and relocates `repo://` evidence resources (`resolver.ts`,
`resource.ts`), including opaque line-range relocation metadata.

### okf — Open Knowledge Format frontmatter, indexing, and verification

Owns OKF concept-page structure. `src/okf/frontmatter.ts` is the principal
entry: it validates OKF frontmatter (`validateOkfFrontmatter`), including the
OKF v0.2 trust families — `generated`, `verified`, `sources`, `status`, and
`stale_after` — via `validateTrustFamilies`. It reads and writes individual
fields while preserving unrelated front-matter lines byte-for-byte
(`parseFrontmatterFields`, `readFrontmatterField`, `setFrontmatterField`), and
stamps producer-owned control fields (`setGeneratedEvent`, `setOkfSources`,
`setOkfVerified`). It also deterministically repairs persisted pages
(`repairOkfFrontmatter`, `repairPersistedFile`), which the repository lifecycle
calls before accepting a page. `index-sync.ts` and `index-labels.ts` keep index
pages and concept-type labels in sync; `claims-verification.ts` synchronizes
and rolls back claim verification; `generated-provenance.ts` and
`claim-sources.ts` handle provenance metadata.

### connectors — external read-only knowledge sources

Owns the built-in source connectors and their MCP plumbing.
`src/connectors/registry.ts` (`createConnectorRegistry`, `CONNECTOR_IDS`) is the
central registry mapping ids (`git-repo`, `slack`, `x`, `google`, `web-search`,
`hackernews`, `langsmith`, `notion`, `custom-mcp`) to runtimes. `tools.ts`
exposes connectors to the agent as tools; `mcp-client.ts` and `mcp-runtime.ts`
run MCP transports; `src/connectors/sources/` holds one file per connector
implementation.

### ingestion — pulling connector content into the wiki

Owns the ingestion command that fetches from configured connectors and feeds the
generation pipeline. Principal entry: `src/ingestion/ingestion.ts`
(`runOpenWikiIngestion`). `src/ingestion/code-mode.ts` prepares repository
("code mode") setup consumed by repository runs.

### cli — command parsing and terminal UI

Owns the executable entrypoint and terminal experience. `src/cli/cli.tsx` is the
`#!/usr/bin/env node` entry that installs the crash guard, parses the command,
and dispatches to the Ink app or a non-interactive runner. `src/cli/commands.ts`
is the large command parser/router (`parseCommand`, and predicates such as
`commandLoadsEnvironment`). `runners.ts` and `integrations.ts` host per-command
handlers; `app/`, `components/`, and `input/` hold the Ink UI.

### auth — provider and OAuth credential management

Owns credential acquisition and storage. Principal entries: `src/auth/oauth.ts`
(OAuth flows) and `src/auth/tokens.ts` (token persistence), with
`oauth-discovery.ts`, `providers.ts`, `configure.ts`, `external-cli-auth.ts`, and
`ngrok.ts` for discovery, provider selection, and tunneling.

### config — environment, home directory, and constants

Owns runtime configuration. `src/config/constants.ts` is the central identifier
registry (path constants, provider env keys, the `OpenWikiProvider` union, and
defaults); `env.ts` loads and saves the OpenWiki `.env`; `openwiki-home.ts`
resolves the home/wiki directories; `reasoning.ts` resolves reasoning settings.

### integrations — host-tool integration and MCP server surface

Owns embedding OpenWiki into external hosts. `src/integrations/core/session-manager.ts`
is the principal entry: `HostSessionManager` is a thin single-run MCP adapter over
the transport-neutral lifecycle core, serializing one lifecycle operation at a time
(`runOperation`) and mapping `RepositoryRunError` codes into stable
`HostIntegrationError`s at the boundary. Its `begin`, `submitPlan`, `nextPage`,
`submitPage`, and `finish` methods delegate to the `generation/repository-run.ts`
lifecycle, and `tools()` returns exactly the five OpenWiki lifecycle tools
(`openwiki_begin`, `openwiki_submit_plan`, `openwiki_next_page`,
`openwiki_submit_page`, `openwiki_finish`) for an MCP transport to expose.
`src/integrations/core/protocol.ts` defines the tool input schemas and host-id
validation; `repository-root.ts` resolves the repository root.
`src/integrations/mcp/server.ts` exposes OpenWiki over MCP (stdio in
`stdio.ts`); `src/integrations/install/` handles host installation.

### visualize — local graph viewer

Owns the interactive wiki/graph viewer. `src/visualize/server.ts`
(`createRequestHandler`) serves the app; `graph.ts` builds the graph model;
`page.ts`, `client.ts`, `client-lib.ts`, and `static-export.ts` render and export
it.

### scheduling — recurring connector and generation runs

Owns cron/launchd scheduling. Principal entry: `src/scheduling/schedules.ts`,
which validates cron expressions and installs, lists, pauses, resumes, and
deletes connector and "power" schedules.

### telemetry — run recording and error classification

Owns opt-out usage telemetry and error taxonomy. `src/telemetry/index.ts` is the
public barrel re-exporting `recordRun`/`recordRunSafe`, `withRunTelemetry`,
error classification (`classifyError`, `tagErrorStage`), and the opt-out gates
(`isTelemetryDisabled`, `isCiEnvironment`). `senders.ts`, `errors.ts`, and
`taxonomy.ts` carry the implementation.

### platform — OS and filesystem primitives

Owns cross-platform helpers shared by other subsystems: `fs-errors.ts`
(`isFileNotFoundError`), `diagnostics.ts` (secret redaction), `language.ts`
(language resolution), `windows-acl.ts`, and `utils.ts`.

### mermaid — diagram validation for generated pages

Owns Mermaid handling in generated wikis: `fences.ts` extracts fences,
`validate.ts` parses/validates them (degrading invalid diagrams), `wiki.ts`
applies the policy to pages, and `dom-shim.ts` provides the headless render
environment.

## How the central subsystems connect

The CLI entrypoint parses a command and, for repository generation, the agent
constructs a model and runs the plan/page loop, which calls the generation
lifecycle; that lifecycle persists claims and validates OKF frontmatter as it
writes each page.

```mermaid
flowchart TD
  CLI["cli/cli.tsx parses and dispatches"] --> Agent["agent/index.ts runOpenWikiAgent"]
  Agent --> Runner["agent/repository-runner.ts plan and page loop"]
  Runner --> Gen["generation/repository-run.ts lifecycle"]
  Gen --> State["generation/run-state.ts durable checkpoint"]
  Gen --> Claims["claims runtime and store"]
  Gen --> OKF["okf/frontmatter.ts validation"]
  Agent --> Connectors["connectors/tools.ts source tools"]
  Config["config/constants.ts identifiers"] -.-> Agent
  Config -.-> Gen
```

Caption: Control flow from the CLI through the agent into the repository
generation lifecycle, with config identifiers shared across subsystems.
