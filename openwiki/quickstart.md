---
type: orientation-guide
title: OpenWiki Quickstart
description: Entry-point orientation for a coding agent working on the OpenWiki CLI codebase, with a task-routing map into the architecture, workflow, concept, operations, integration, and testing pages.
tags: [openwiki, quickstart, cli, orientation, task-routing, deepagents]
verified:
  - by: openwiki/0.3.3
    at: 2026-08-25T02:14:25.283Z
sources:
  - id: openwiki-source-8037e2358a2c4f9b2c722a11
    resource: repo://AGENTS.md
  - id: openwiki-source-f317ee207e1653d2033c81a4
    resource: repo://CONTRIBUTING.md
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-5c43e3fe562cf274dd6a5564
    resource: repo://src/cli/cli.tsx
  - id: openwiki-source-3fc16f0371ced4d94330f06c
    resource: repo://src/cli/commands.ts
generated: { by: "openwiki/0.3.3", at: "2026-08-25T02:14:25.283Z" }
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

Find your task on the left, then read the page on the right.

### Understand the system

| I want to…                                                                                         | Read                                                                             |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Get the top-level picture of how the CLI, agent, modes, and finalization fit together              | [Architecture Overview](/openwiki/architecture/overview.md)                      |
| Understand how the DeepAgents documentation agent is built (models, backends, prompts, middleware) | [Agent Runtime, Models, and Middleware](/openwiki/architecture/agent-runtime.md) |
| Find which subsystem lives where under `/src`                                                      | [Source Map](/openwiki/architecture/source-map.md)                               |

### Learn the core concepts

| I want to…                                                                       | Read                                                                     |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Understand the two operating modes and where each writes its state               | [Code vs Personal Modes](/openwiki/concepts/two-modes.md)                |
| Understand grounded Claims: material facts tied to versioned repository evidence | [Grounded Claims](/openwiki/concepts/grounded-claims.md)                 |
| See what OKF output looks like (frontmatter, provenance, validated Mermaid)      | [Open Knowledge Format Output](/openwiki/concepts/okf-output.md)         |
| Choose a model provider and configure its credentials                            | [Model Providers and Credentials](/openwiki/concepts/model-providers.md) |

### Follow a workflow end to end

| I want to…                                                                                              | Read                                                                             |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Set up OpenWiki for the first time (provider/model, credentials, repo setup)                            | [Onboarding and Setup](/openwiki/workflows/onboarding.md)                        |
| Trace the resumable page-job generation flow (`begin → submit_plan → next_page → submit_page → finish`) | [Repository Generation Lifecycle](/openwiki/workflows/repository-generation.md)  |
| Understand how Claims are reconciled on update and how a page submits its full Claim set                | [Claims Reconciliation on Update](/openwiki/workflows/claims-reconciliation.md)  |
| Understand deterministic finalization, index/provenance sync, and link validation                       | [Wiki Finalization and Link Integrity](/openwiki/workflows/wiki-finalization.md) |
| Trace how personal-mode ingestion pulls connector sources and updates the brain                         | [Personal Mode Ingestion](/openwiki/workflows/personal-ingestion.md)             |

### Operate and configure it

| I want to…                                                                                   | Read                                                                   |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Look up CLI commands and flags (init/update, mode, print, integrations, visualize, schedule) | [CLI Commands and Flags](/openwiki/operations/cli-reference.md)        |
| Configure environment variables and the local state directory                                | [Configuration and Environment](/openwiki/operations/configuration.md) |
| Set up scheduled self-update in CI and the docs-PR workflow                                  | [CI Scheduling and Self-Update](/openwiki/operations/ci-scheduling.md) |
| Understand opt-out telemetry and diagnostics                                                 | [Telemetry and Diagnostics](/openwiki/operations/telemetry.md)         |

### Integrate with other tools

| I want to…                                                                                                        | Read                                                                                         |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Run OpenWiki inside Codex, Claude Code, or OpenCode                                                               | [Coding-Agent Integrations (Codex/Claude/OpenCode)](/openwiki/integrations/coding-agents.md) |
| Use or add a source connector (Custom MCP, Notion, Slack, Gmail, X, Web Search, Hacker News, LangSmith, git-repo) | [Source Connectors](/openwiki/integrations/connectors.md)                                    |
| Publish or explore the wiki as an interactive graph                                                               | [Interactive Visualizer](/openwiki/integrations/visualizer.md)                               |

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

On a persistent checkout, an interrupted `openwiki --init` can resume the durable
page queue by rerunning the same command; ephemeral CI runners start fresh after
failure unless their workspace is preserved.
