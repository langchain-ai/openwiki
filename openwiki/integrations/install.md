---
type: Reference
title: Coding-Agent Integration Install
description: How OpenWiki installs its host skill and managed MCP config into Codex, Claude Code, and OpenCode — the host registry, install scope, transactional skill install, idempotence, surgical config edits, and OpenCode-specific paths.
tags: [integrations, install, mcp, codex, claude, opencode]
verified:
  - by: openwiki/0.3.3
    at: 2026-08-24T23:37:28.906Z
sources:
  - id: openwiki-source-3fc16f0371ced4d94330f06c
    resource: repo://src/cli/commands.ts
  - id: openwiki-source-ada18c62d92003b613355e30
    resource: repo://src/cli/integrations.ts
  - id: openwiki-source-ce169075085dcc1a24c7601d
    resource: repo://src/integrations/core/repository-root.ts
  - id: openwiki-source-2ee243215d1bc77f9f1a0473
    resource: repo://src/integrations/install/atomic-file.ts
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
generated: {by: "openwiki/0.3.3", at: "2026-08-24T23:37:28.906Z"}
---

# Coding-Agent Integration Install

The installer places OpenWiki's host skill and a managed MCP server entry into a supported coding agent so the [lifecycle tools](overview.md) become available. It is driven from a fixed host registry and exercised by the `openwiki integrations` CLI (see [CLI runners](../cli/runners.md)).

## Host registry

Three host targets are supported. The registry is an immutable map keyed by stable identifier; `getHostTarget` resolves untrusted CLI text against it and `listHostTargets` enumerates it in registry order (codex, claude, opencode).

| Host                    | Config kind      | User config path                              | Project config path        | Skill directory (user)            | Skill directory (project)     | Producer actor  |
| ----------------------- | ---------------- | --------------------------------------------- | -------------------------- | --------------------------------- | ----------------------------- | --------------- |
| `codex` (Codex)         | `codex-toml`     | `.codex/config.toml`                          | `.codex/config.toml`       | `.agents/skills/openwiki`         | `.agents/skills/openwiki`     | `codex`         |
| `claude` (Claude Code)  | `json`           | `.claude.json`                                | `.mcp.json`                | `.claude/skills/openwiki`         | `.claude/skills/openwiki`     | `claude-code`   |
| `opencode` (OpenCode)   | `opencode-json`  | `.config/opencode/opencode.jsonc`             | `opencode.jsonc`           | `.config/opencode/skills/openwiki`| `.opencode/skills/openwiki`   | `opencode`      |

Each target carries its own **producer actor**, the stable OKF producer stamped on page bodies authored through that host. The default managed MCP command launches the `openwiki` binary as `openwiki mcp --host <target>`; the same command shape is recorded in the skill receipt and reconciled on every install.

### OpenCode-specific paths

OpenCode is the one target whose user and project destinations differ structurally:

- **User scope** installs under `~/.config/opencode`, OpenCode's global configuration directory on every supported platform: skill at `.config/opencode/skills/openwiki` and MCP config at `.config/opencode/opencode.jsonc`.
- **Project scope** installs under the repository's `.opencode/` directory: skill at `.opencode/skills/openwiki` and MCP config at the repository-root-relative `opencode.jsonc`.

OpenCode's config kind is `opencode-json`, a JSONC adapter that preserves comments and unrelated siblings while owning the `mcp.openwiki` entry.

## Install scope

Every operation takes an explicit `scope` of `user` or `project`. The CLI defaults to **user scope**; `--project [path]` switches to project scope.

- **User scope** anchors destinations to the user's home directory (`os.homedir()` from the CLI). The root must be an existing directory.
- **Project scope** anchors destinations to a Git worktree root resolved via `git rev-parse --show-toplevel`; the root must be inside a Git repository and may be reached from any subdirectory of it. The filesystem root and the user's home directory are deliberately refused so a globally installed integration cannot treat an ambiguous launch directory as a wiki repository.

User and project installations are independent: installing or uninstalling one scope never touches the other. All three current targets support both scopes (their `user` paths are non-null), so `status` never reports `unsupported` for them.

## Installing the skill

Install refuses to overwrite an unmanaged or modified existing skill unless `--force` is passed. When the installed skill already matches the current version, files, and MCP command, install only reconciles the managed config entry and reports **no skill change** (`changed: false`) — install is idempotent.

Otherwise the skill is installed **transactionally**:

<!-- openwiki: mermaid parse failed and this diagram was converted to a text fence so it does not break rendering. Fix the diagram source and restore the mermaid fence. Parser error: Parse error on line 4: ...ntory"] Inspect -> Check{"existing s Expecting 'SEMI', 'NEWLINE', 'EOF', 'AMP', 'START_LINK', 'LINK', 'LINK_ID', got 'MINUS' -->
```text
flowchart TD
    Start["install target, scope, root"] --> Resolve["resolve canonical scope, skill, and config paths"]
    Resolve --> Inspect["inspect existing skill receipt and inventory"]
    Inspect -> Check{"existing skill<br/>modified?"}
    Check -- "yes, no --force" --> Reject["conflict error"]
    Check -- "no or --force" --> Idem{"already current<br/>version, files, command?"}
    Idem -- yes --> ReconcileOnly["reconcile managed config entry only"]
    Idem -- no --> Stage["copy bundle into private staging sibling"]
    Stage --> Verify["inventory staging and compare to canonical"]
    Verify --> Fail{"mismatch?"}
    Fail -- yes --> CleanStage["remove staging and fail"]
    Fail -- no --> Receipt["write ownership receipt into staging"]
    Receipt --> Commit["snapshot config, mutate config, move prior skill aside, atomically move staging into place"]
    Commit --> CommitFail{"commit failed?"}
    CommitFail -- yes --> Rollback["restore prior skill and config, remove staging"]
    CommitFail -- no --> Cleanup["remove non-forced prior skill or retain forced backup"]
    ReconcileOnly --> Done["report result"]
    Cleanup --> Done
```

_Transactional skill install and rollback._

The bundle is copied into a private staging sibling (a dot-prefixed, collision-resistant sibling of the destination), inventoried and compared against the canonical bundle, receipted, and only then atomically committed into place. Staging is removed on any staging-phase failure. Install also refuses to proceed through a symlinked path component in the skill or config destination.

### Commit and rollback

The commit step snapshots the MCP config first, mutates the config, moves any prior skill aside (into a `rollback` sibling, or a timestamped `backup` sibling when `--force` is set), and then atomically moves staging into the destination. A `committed` flag gates rollback: only a pre-commit failure rolls back. Rollback restores the prior skill from its sibling, restores the config snapshot (re-creating absence when the config did not exist), and removes staging; if any rollback step itself fails, the original error is wrapped in an `AggregateError` so the incomplete rollback is visible. Non-forced prior-skill siblings are removed after a successful commit; forced backups are retained and surfaced via `backupPath` in the result.

## Uninstall and config edits

Uninstall refuses to remove a **modified** skill or a modified/unmanaged MCP config entry, and is a no-op (`changed: false`) when neither a managed skill nor a managed config entry exists. When both exist it removes the config entry first, then moves the skill into a cleanup sibling and removes it, finally pruning empty skill ancestors while preserving the host-owned top-level directory (e.g. `.agents`, `.claude`, `.opencode`). If the skill move fails after the config was changed, the config snapshot is restored. A retained cleanup backup is surfaced via `backupPath` when its removal fails.

Managed MCP config edits are **surgical** and adapter-specific, but share the same contract: the `openwiki` entry is added or replaced without discarding unrelated config, an unchanged entry reports `false`, and a foreign `openwiki` entry that is not the replaceable one raises a `conflict`. All writes go through an atomic temp-file-and-rename helper that preserves existing file mode bits.

- **`json` (Claude Code)** owns `mcpServers.openwiki` as `{ command, args }`. Property order is irrelevant; any extra keys or argument drift is treated as modified and refused.
- **`codex-toml` (Codex)** owns a marker-delimited block between `# OPENWIKI:MCP:START` and `# OPENWIKI:MCP:END` containing `[mcp_servers.openwiki]`. Bytes outside the block are preserved verbatim. An unmanaged `[mcp_servers.openwiki]` table outside the marker range is a conflict; incomplete, out-of-order, or duplicated markers are an `invalid_input` error.
- **`opencode-json` (OpenCode)** owns `mcp.openwiki` as `{ type: "local", command: [command, ...args], enabled: true }` inside JSONC. Comments and unrelated siblings are preserved. An entry the user has annotated with line or block comments is treated as modified and refused on both replace and uninstall; malformed JSONC is an `invalid_input` error that leaves bytes unchanged.

The `status` operation combines skill and config state: `not-installed` only when both are absent, `installed` only when both are intact, otherwise `modified`.
