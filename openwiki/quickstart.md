---
type: orientation-guide
title: OpenWiki Quickstart
description: Entry-point orientation for a coding agent working on the OpenWiki CLI codebase, with a task-routing map into the architecture, workflow, concept, operations, integration, and testing pages.
tags: [openwiki, quickstart, cli, orientation, task-routing, deepagents]
verified:
  - by: openwiki/0.4.3
    at: 2026-08-28T03:39:43.412Z
sources:
  - id: openwiki-source-8037e2358a2c4f9b2c722a11
    resource: repo://AGENTS.md
  - id: openwiki-source-f317ee207e1653d2033c81a4
    resource: repo://CONTRIBUTING.md
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-6cb3236b8c1412a26d832fcf
    resource: repo://src/agent/repository-runner.ts
  - id: openwiki-source-69abc6f0f641147820a274bc
    resource: repo://src/agent/utils.ts
  - id: openwiki-source-5c43e3fe562cf274dd6a5564
    resource: repo://src/cli/cli.tsx
  - id: openwiki-source-3fc16f0371ced4d94330f06c
    resource: repo://src/cli/commands.ts
  - id: openwiki-source-7c5ecb56558cc061dab24f9d
    resource: repo://src/generation/repository-run.ts
  - id: openwiki-source-080c4525024a9b689e361cbb
    resource: repo://src/generation/run-state.ts
generated: { by: "openwiki/0.4.3", at: "2026-08-28T03:39:43.412Z" }
---

# OpenWiki Quickstart

OpenWiki is a command-line tool that writes and maintains a Markdown wiki for a
codebase or for personal knowledge. A [Deep Agents](https://github.com/langchain-ai/deepagentsjs)
documentation agent reads your sources, synthesizes a linked wiki you own, and
keeps it current as those sources change. It is built for agents to read as
memory and ships an interactive visualizer for humans to explore.

This page orients a coding agent to the codebase and routes you to the page that
matches your task. Read this first, then follow the links below.

## What OpenWiki is

OpenWiki is published as the `openwiki` npm package, a Node.js (22+) CLI whose
binary resolves to `dist/cli/cli.js`. Its purpose, per the package manifest, is
"a CLI that uses a DeepAgents documentation agent to generate and maintain an
OpenWiki for a codebase." The runtime is a DeepAgents documentation agent driven
by one of several model providers, wrapped by a CLI that can run interactively
(an Ink TUI) or one-shot (print mode).

The CLI has two operating modes:

- **Code** _(default)_ — documents the current repository and writes the wiki to
  `openwiki/` inside the repo.
- **Personal** — documents your connected sources and writes to
  `~/.openwiki/wiki`.

## Developer workflow

OpenWiki is a pnpm + TypeScript project. The commands you will use most:

```sh
pnpm install          # install dependencies
pnpm run build        # tsc (server + client) then copy visualizer assets
pnpm run dev          # run the CLI from source via tsx (src/cli/cli.tsx)
pnpm run coverage     # run the Vitest suite with coverage
pnpm test             # typecheck + build + coverage (the full CI-equivalent gate)
```

`pnpm run dev` executes the TypeScript entrypoint directly with `tsx`, while the
shipped binary runs the compiled `dist/cli/cli.js`. Before opening a PR, run
`pnpm run format`, `pnpm run lint`, and `pnpm test`; `format` and `lint` mirror
the per-PR checks and `test` typechecks, builds, and runs Vitest with coverage.

To exercise the CLI against another local repository, link the package globally
(`pnpm link --global`) or alias `openwiki` to `node /path/to/openwiki/dist/cli/cli.js`,
then run it from the target repo's working directory.

## Entrypoint and control flow

The process entrypoint is `src/cli/cli.tsx`. It installs a crash guard before any
run so escaped rejections are recorded with telemetry, parses the argument vector
into a command, and dispatches:

- `integrations` and `mcp` commands go to the host-integration surface
  (`runIntegrationsCommand` / `runMcpCommand`).
- All other commands run through the native pipeline, which loads environment,
  resolves the startup command, and then either prints a startup error, runs
  non-interactively in print mode, or renders the interactive Ink `App`.

The `dev` script points at this same `.tsx` file, so behavior is identical
between `pnpm run dev` and the built binary.

## Task-routing map

Find your task on the left, then read the page on the right. This routes you to
the canonical wiki pages; each one links into the deeper source map.

### Understand the system

| I want to…                                                                                                          | Read                                                        |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Get the top-level picture of how the CLI, agent, modes, resumable generation, Claims, finalization, connectors, and the visualizer fit together | [Architecture Overview](/openwiki/architecture/overview.md) |
| Find which subsystem lives where under `/src`                                                                       | [Source Map](/openwiki/architecture/source-map.md)          |

### Learn the core concepts

| I want to…                                                                        | Read                                                                 |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Understand grounded Claims: material facts tied to versioned repository evidence   | [Grounded Claims](/openwiki/concepts/grounded-claims.md)             |
| See what OKF output looks like (frontmatter, provenance, validated Mermaid)        | [Open Knowledge Format Output](/openwiki/concepts/okf-output.md)     |

### Follow a workflow end to end

| I want to…                                                                                                              | Read                                                                  |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Set up OpenWiki for the first time (provider/model, credentials, repo setup)                                            | [First-Run Onboarding](/openwiki/workflows/onboarding.md)             |
| Trace the resumable page-job generation flow (`begin → submit_plan → next_page → submit_page → finish`)                  | [Repository Generation Workflow](/openwiki/workflows/repository-generation.md) |
| Understand how a failing or early-exiting page worker is skipped and restored without losing completed pages            | [Repository Generation Workflow](/openwiki/workflows/repository-generation.md) |
| Understand how repository source drift during a run is detected and why the run finalizes without advancing the source checkpoint | [Repository Generation Workflow](/openwiki/workflows/repository-generation.md) |
| Understand how Claims are reconciled on update and how a page submits its full Claim set                                | [Claims Reconciliation](/openwiki/workflows/claims-reconciliation.md) |
| Understand deterministic finalize-once finalization, index/provenance sync, link validation, and skipped-page restore on finish | [Wiki Finalization Workflow](/openwiki/workflows/wiki-finalization.md) |

### Operate and configure it

| I want to…                                                                                   | Read                                                         |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Look up CLI commands and flags (init/update, mode, print, integrations, visualize, schedule) | [CLI Reference](/openwiki/operations/cli-reference.md)        |
| Set up scheduled self-update in CI and the docs-PR workflow                                  | [CI Scheduling and Self-Update](/openwiki/operations/ci-scheduling.md) |

### Integrate with other tools

| I want to…                                                                  | Read                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------ |
| Run OpenWiki inside Codex, Claude Code, OpenCode, or Cursor                 | [Coding-Agent Integrations](/openwiki/integrations/coding-agents.md) |

### Test your changes

| I want to…                                                | Read                                           |
| --------------------------------------------------------- | ---------------------------------------------- |
| Understand the test layout and how to run and scope tests | [Testing Guide](/openwiki/testing/overview.md) |

## Where OpenWiki keeps its state

- **Repository (code) wiki:** written to `openwiki/` in the repo, alongside the
  structured Claims sidecar under `openwiki/.claims/` and in-progress run state
  in `openwiki/.run.json`.
- **Local state:** credentials, the personal wiki, connector data, conversation
  history, and skills live under `~/.openwiki` by default; set
  `OPENWIKI_CONFIG_DIR` to relocate to a different writable directory.

Repository (code) generation follows the resumable page-job flow
`begin → submit_plan → next_page → submit_page → … → finish`. Each page job has
a `PageJobStatus` of `pending`, `skipped`, or `complete`. A worker that fails or
exits without submitting its page is marked `skipped` and rolled back to its
pre-worker state so completed pages are not lost; the run can still `finish` once
every remaining job is `complete` or `skipped`, and a resumed run resets skipped
jobs back to `pending` so they are re-attempted. In-progress runs are recorded in
`openwiki/.run.json`; on a persistent checkout, an interrupted run resumes the
durable page queue, while ephemeral CI runners start fresh after failure unless
their workspace is preserved. An update whose Claims preflight is clean, source
fingerprint is unchanged, and every existing page has complete baseline coverage
is proven a strict no-op at `begin` time and skips model invocation.

Finalization is deterministic and runs once. `finishRepositoryRun` refuses to
finish while any page job is still `pending`, validates that every `skipped` job
carries its original page snapshot, restores skipped pages to their pre-worker
Markdown and Claims, persists and proves the reconciled Claims durable, and only
then removes `openwiki/.run.json` — so any earlier failure leaves the run
resumable. If repository source changed while OpenWiki was running (detected by
re-fingerprinting the source before and after finalization), the run finalizes
without advancing the source checkpoint and writes `interrupted` update metadata
instead of `complete`, prompting a follow-up `openwiki --update` to reconcile the
drift.

## Host-driven generation

OpenWiki can also run inside a host coding agent (Codex, Claude Code, OpenCode,
or Cursor) instead of launching its own model. The integration shares one
canonical skill and the same five MCP tools as native generation:
`openwiki_begin`, `openwiki_submit_plan`, `openwiki_next_page`,
`openwiki_submit_page`, and `openwiki_finish`. The host owns repository research,
planning, and factual authoring; OpenWiki owns the durable queue, Claims
reconciliation, source-drift handling, and deterministic finalization. Host-driven
runs currently support repository code wikis (not personal brains), use the host's
authenticated model session, and use repository source and tests only — connector
context (including LangSmith) is not yet supported. See
[Coding-Agent Integrations](/openwiki/integrations/coding-agents.md) for install
scope, the host registry, and the host-driven lifecycle boundary.
