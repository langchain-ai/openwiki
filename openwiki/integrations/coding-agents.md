---
type: integration guide
title: Coding-Agent Integrations (Codex/Claude/OpenCode)
description: How OpenWiki runs inside a host coding agent through the five-operation MCP page-job protocol, how install writes host config and the shared skill bundle, and the divided ownership between host research and OpenWiki finalization.
tags: [integrations, mcp, coding-agents, installation, page-job, host]
verified:
  - by: openwiki/0.3.3
    at: 2026-08-25T02:14:25.283Z
sources:
  - id: openwiki-source-f317ee207e1653d2033c81a4
    resource: repo://CONTRIBUTING.md
  - id: openwiki-source-438fff4d79b8ab99f5c88c73
    resource: repo://integrations/openwiki/SKILL.md
  - id: openwiki-source-ada18c62d92003b613355e30
    resource: repo://src/cli/integrations.ts
  - id: openwiki-source-7c5ecb56558cc061dab24f9d
    resource: repo://src/generation/repository-run.ts
  - id: openwiki-source-5c32d5425e61a6c32d810844
    resource: repo://src/integrations/core/errors.ts
  - id: openwiki-source-410e7efbe6dee8c4d43e9b4d
    resource: repo://src/integrations/core/protocol.ts
  - id: openwiki-source-ce169075085dcc1a24c7601d
    resource: repo://src/integrations/core/repository-root.ts
  - id: openwiki-source-58835b77ce38a0dd1fed8d09
    resource: repo://src/integrations/core/session-manager.ts
  - id: openwiki-source-2d3b31afd763da198a5938b7
    resource: repo://src/integrations/install/config-json.ts
  - id: openwiki-source-e750121933b611f9b383236a
    resource: repo://src/integrations/install/config-opencode.ts
  - id: openwiki-source-a3f1e802707868b30976fb6a
    resource: repo://src/integrations/install/config-toml.ts
  - id: openwiki-source-de8ae1002d3cb76f17b88053
    resource: repo://src/integrations/install/install-paths.ts
  - id: openwiki-source-2557815e72f267f9941d446a
    resource: repo://src/integrations/install/installer.ts
  - id: openwiki-source-c194ba7f94bf86a83012a7b4
    resource: repo://src/integrations/install/registry.ts
  - id: openwiki-source-0d3cbb56d1014c5a7cb718ba
    resource: repo://src/integrations/install/skill-bundle.ts
  - id: openwiki-source-f8d9d540e042f0435d885368
    resource: repo://src/integrations/install/types.ts
  - id: openwiki-source-eab9328975981f427c4218d0
    resource: repo://src/integrations/mcp/server.ts
  - id: openwiki-source-6f06cc988142430d18f2233e
    resource: repo://src/integrations/mcp/stdio.ts
generated: { by: "openwiki/0.3.3", at: "2026-08-25T02:14:25.283Z" }
---

# Coding-Agent Integrations (Codex/Claude/OpenCode)

OpenWiki can run _inside_ a host coding agent (Codex, Claude Code, or OpenCode)
instead of as a standalone process. The host agent supplies the model, native
repository tools, and Markdown authoring; OpenWiki supplies a deterministic,
resumable **page-job lifecycle** over the Model Context Protocol (MCP). The two
sides communicate through exactly five MCP tools, and installation wires a local
stdio MCP server plus a shared skill bundle into each host's own configuration.

This page documents the protocol operations, the divided ownership of research
versus finalization, repository-root resolution, install/uninstall mechanics,
and the scope model. For the internal generation engine these tools drive, see
[Repository generation workflow](/openwiki/workflows/repository-generation.md)
and [Architecture overview](/openwiki/architecture/overview.md). For the
`openwiki mcp` and `openwiki integrations` commands, see the
[CLI reference](/openwiki/operations/cli-reference.md).

> Note: This is the **host integration** path. It is unrelated to the
> `write-connector` skill, which adds a new _source connector_ for ingesting
> external content. To add a new host, follow
> `CONTRIBUTING.md` §"Adding a coding-agent integration".

## Ownership boundary

The integration keeps a deliberately narrow boundary. The host model researches
and authors **only the current PageJob**; OpenWiki owns durable run state, the
page queue, Claims validation and reconciliation, indexes, provenance,
finalization, and all managed setup files. This split is stated in the shared
skill (`integrations/openwiki/SKILL.md`) and reinforced in the MCP server
instructions advertised at initialization
(`src/integrations/mcp/server.ts`).

## The five MCP operations

`HostSessionManager.tools()` exposes exactly five transport-neutral lifecycle
tools, in order: `openwiki_begin`, `openwiki_submit_plan`, `openwiki_next_page`,
`openwiki_submit_page`, and `openwiki_finish`. Each tool parses its input against
a strict Zod schema before delegating to the repository-generation core.

- **`openwiki_begin`** — Starts or resumes a run for an absolute Git root in
  mode `init` or `update`, with optional `language` and `force`. It resolves the
  root, calls `beginRepositoryRun`, and either records the active run or returns
  a proven update **no-op** (`status=noop`) without an active run. A clean update
  returns no-op so the host reports "no update required" and stops.
- **`openwiki_submit_plan`** — Persists the run's final canonical page plan.
  `pages` may be empty (a valid update with no page work or only deletions), and
  `deletePages` is optional.
- **`openwiki_next_page`** — Returns the first pending page job with its current
  Claims, or `status=complete` when the queue is drained.
- **`openwiki_submit_page`** — Completes the active job after its Markdown is
  written by submitting that page's complete intended Claim set (at least one
  material, repository-grounded Claim). Structural `index.md` pages are
  generated deterministically and never become jobs.
- **`openwiki_finish`** — Finalizes the run only after every job is complete:
  deletion, validation, indexing, provenance, Claims finalization, and metadata
  persistence, then clears process-local state.

```mermaid
sequenceDiagram
    participant Host as Host Agent
    participant SM as HostSessionManager
    participant Core as Repository Run Core
    Host->>SM: openwiki_begin(root, mode)
    SM->>Core: resolve root + beginRepositoryRun
    Core-->>Host: noop OR planning run
    Host->>SM: openwiki_submit_plan(pages, deletePages)
    SM->>Core: submitRepositoryPlan
    loop until complete
        Host->>SM: openwiki_next_page
        SM->>Core: nextRepositoryPage
        Core-->>Host: pending job OR complete
        Host->>SM: openwiki_submit_page(jobId, claims)
        SM->>Core: submitRepositoryPage
    end
    Host->>SM: openwiki_finish
    SM->>Core: finishRepositoryRun
    Core-->>Host: complete
```

The MCP page-job lifecycle a host agent drives end to end.

## Session lifecycle and invariants

`HostSessionManager` is a **single-run** adapter over the transport-neutral
lifecycle core. It holds one process-local `ActiveRepositoryRun` and enforces
several invariants:

- **Single active run.** `requireSession(runId)` rejects any operation whose
  `runId` does not match the currently active run with an `invalid_state` error,
  telling the caller to `openwiki_begin` first. `begin` clears the active run on
  no-op and sets it on a real run; `finish` clears it on success.
- **Serialized operations.** `runOperation` acquires a single-operation guard
  (`startOperation`) and rejects concurrent lifecycle calls with `invalid_state`;
  the guard is always released in a `finally` block.
- **Bounded, mapped errors.** `mapRepositoryRunError` converts internal
  `RepositoryRunError` codes into stable `HostIntegrationError` codes
  (`conflict`, `invalid_input`, `invalid_state`). The MCP transport further wraps
  any non-`HostIntegrationError` as a generic "OpenWiki MCP operation failed."
  so unexpected exception detail never leaks through the transport.

`HostSessionManager.create` validates the host identity against a lowercase
`[a-z0-9-]{1,64}` pattern (`isValidHostId`) and derives the metadata model
identity as `host-agent/<host>`; the producer actor defaults to the host id when
not supplied.

## Repository-root resolution and safety

`resolveRepositoryRoot` turns a host-supplied path into a canonical Git worktree
root before any run begins. It requires an absolute path, canonicalizes it with
`realpath`, verifies it is a directory, and asks Git for the top-level worktree
via `git -C <dir> rev-parse --show-toplevel` (a bounded, read-only query with a
10-second timeout). It then **refuses the filesystem root and the user's home
directory** so a globally installed integration cannot treat an ambiguous launch
directory as a wiki repository. All failures surface as `invalid_input` errors
without exposing the offending path.

## Connector context is not yet supported here

The repository-generation core accepts an optional `planningContext` (user and
connector context) for planning and replanning, but `HostSessionManager.begin`
does not forward one — it passes only `root`, `mode`, `language`, `force`, and
actor identities. Host-driven runs therefore run without connector context in
this path today.

## The MCP transport

`runOpenWikiMcp` starts the local stdio server: it creates a
`HostSessionManager`, builds the MCP server with `createOpenWikiMcpServer`, and
connects a `StdioServerTransport`. The adapter registers each lifecycle tool's
schema and description with the MCP SDK and executes it through `executeTool`.
The server is invoked by the CLI's `openwiki mcp --host <id>` command, which
looks up the host's registry entry to supply the correct provenance actor.

## Installation: host config and the skill bundle

Installing an integration writes two managed artifacts into a host's chosen
scope: a **skill directory** (a copy of the canonical `integrations/openwiki`
bundle) and a **managed MCP server entry** in the host's config file. The
`HostIntegrationInstaller` performs this transactionally.

### The host registry

`HOST_TARGETS` in `src/integrations/install/registry.ts` is the immutable
registry of supported hosts. Each entry declares its display name, provenance
actor, per-scope skill directory and MCP config, and a documentation URL:

- **Codex** — `.codex/config.toml` (`codex-toml`), skill under
  `.agents/skills/openwiki`, at both user and project scope.
- **Claude Code** — user config `.claude.json` and project config `.mcp.json`
  (both `json`), skill under `.claude/skills/openwiki`.
- **OpenCode** — user config `.config/opencode/opencode.jsonc` and project config
  `opencode.jsonc` (both `opencode-json`), with distinct user/project skill
  directories (`.config/opencode/...` vs `.opencode/...`).

`defaultMcpServerCommand(target)` produces the published invocation
`openwiki mcp --host <target>`, which is what installed configs launch.

### Config adapters

Three adapters own the managed entry per config kind, each preserving unrelated
user configuration and enforcing exact ownership:

- **`json`** adds/removes an `mcpServers.openwiki` entry and refuses to touch an
  `openwiki` entry it does not own.
- **`codex-toml`** writes a fenced block delimited by `# OPENWIKI:MCP:START` /
  `# OPENWIKI:MCP:END` and refuses to replace a modified block or an unmanaged
  `openwiki` table.
- **`opencode-json`** edits the `mcp.openwiki` local-server entry in JSONC while
  preserving surrounding comments.

Each adapter reports whether its entry is `not-installed`, `installed`, or
`modified`, and refuses to overwrite or remove content it did not author.

### Skill bundle and ownership receipt

The canonical bundle is resolved relative to the installer module
(`resolveCanonicalSkillBundle`) and inventoried into a deterministic SHA-256
hash map keyed by relative path (`inventorySkill`), which requires a `SKILL.md`
at the root. On install, a `.openwiki-install.json` **receipt** records the
owning package, OpenWiki version, host target, installed MCP command, and per-
file hashes. `inspectInstallation` uses the receipt to classify a destination as
`not-installed`, `installed` (intact), or `modified` (present but altered or
unmanaged).

### Transactional install/uninstall

`install` stages the bundle into a private sibling directory, verifies the staged
copy matches the canonical inventory, writes the receipt, then commits by
snapshotting the config, mutating it, moving any prior skill aside, and atomically
moving the staged skill into place. On any failure it rolls back the config and
prior skill; an incomplete rollback is surfaced as an `AggregateError`. When the
installed state already matches the requested version, command, and files, it
only reconciles config and reports whether anything changed. A `modified`
destination is refused unless `--force`, which preserves the prior skill as a
timestamped backup.

`uninstall` refuses to remove a `modified` skill or a modified/unmanaged config
entry, snapshots the config for rollback, removes the managed entry, moves the
skill to a cleanup backup, and prunes now-empty skill parent directories.
`status` reports `installed` only when both the skill and the config entry are
intact, `modified` when either is partially present, and `unsupported` when the
requested scope does not exist for the host.

## User-level vs project scope

Every host supports **project** scope; user scope is optional (`user` may be
`null` in the registry, though all three current hosts support both). For
**project** scope the installer resolves the root through the same
`resolveRepositoryRoot` used by runs, so a project install always lands at the
Git worktree root; for **user** scope it anchors at the home directory. When a
host does not support the requested scope, `resolveInstallContext` raises an
`invalid_input` error directing the user to re-run with `--project`.

## Contributing a new host

Adding a host is a registry-and-config change, not a new skill or new tools: add
the id to `HostTargetId`, add the entry to `HOST_TARGETS`, reuse an existing
config adapter when possible (add a focused one only for a genuinely different
format), and add focused registry/install/status/uninstall/config-conflict tests.
The full procedure, including the local dogfooding command
`pnpm integrations:dev <host>`, lives in `CONTRIBUTING.md` §"Adding a
coding-agent integration".

## Focused tests

Behavior is pinned by the integration test suite under `test/integrations/`:
`session-manager.test.ts` drives the full lifecycle over real temporary Git
repositories; `mcp-server.test.ts` and `mcp-stdio.test.ts` cover the transport
adapter; `protocol.test.ts` covers schema validation; `repository-root.test.ts`
covers root resolution and its safety refusals; and `installer.test.ts`,
`config-adapters.test.ts`, `skill.test.ts`, and `package-contents.test.ts` cover
the transactional installer, config ownership, and packaged bundle.
