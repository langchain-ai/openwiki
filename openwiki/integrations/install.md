---
type: Reference
title: Coding-Agent Integration Install
description: How OpenWiki installs its host skill and managed MCP config into Codex and Claude Code — the host registry, transactional skill install, idempotence, and surgical config edits.
tags: [integrations, install, mcp, codex, claude]
sources:
  - id: openwiki-source-2d3b31afd763da198a5938b7
    resource: repo://src/integrations/install/config-json.ts
  - id: openwiki-source-2557815e72f267f9941d446a
    resource: repo://src/integrations/install/installer.ts
  - id: openwiki-source-c194ba7f94bf86a83012a7b4
    resource: repo://src/integrations/install/registry.ts
generated: { by: "openwiki/0.3.3", at: "2026-08-22T08:02:55.052Z" }
verified:
  - by: openwiki/0.3.3
    at: 2026-08-22T08:02:55.052Z
---

# Coding-Agent Integration Install

The installer places OpenWiki's host skill and a managed MCP server entry into a supported coding agent so the [lifecycle tools](overview.md) become available.

## Host registry

Two host targets are supported:

| Host                   | Config kind | Config path                                   | Skill directory           |
| ---------------------- | ----------- | --------------------------------------------- | ------------------------- |
| `codex` (Codex)        | TOML        | `.codex/config.toml`                          | `.agents/skills/openwiki` |
| `claude` (Claude Code) | JSON        | `.claude.json` (user) / `.mcp.json` (project) | `.claude/skills/openwiki` |

Each target carries its own producer actor. The default managed MCP command launches the `openwiki` binary as `openwiki mcp --host <target>`.

## Installing the skill

Install refuses to overwrite an unmanaged or modified existing skill unless `--force` is passed. When the installed skill already matches the current version, files, and MCP command, install only reconciles the managed config entry and reports **no skill change** — install is idempotent.

Otherwise the skill is installed **transactionally**:

```mermaid
flowchart TD
    Start["install"] --> Check{"existing skill<br/>modified?"}
    Check -- "yes, no --force" --> Reject["conflict error"]
    Check -- no --> Stage["copy bundle into private staging sibling"]
    Stage --> Verify["verify against canonical inventory + write receipt"]
    Verify --> Fail{"failure?"}
    Fail -- yes --> Clean["remove staging"]
    Fail -- no --> Commit["atomically commit into place"]
    Commit --> Config["reconcile managed MCP config"]
```

_Transactional skill install._

The bundle is copied into a private staging sibling, verified against the canonical inventory, receipted, and only then atomically committed into place, with staging removed on any failure. Install also refuses to proceed through a symlinked path component in the skill directory.

## Uninstall and config edits

Uninstall refuses to remove a **modified** skill or a modified/unmanaged MCP config entry, and is a no-op when neither a managed skill nor a managed config entry exists.

Managed MCP config edits are **surgical**: the `openwiki` entry is added or replaced without discarding unrelated config, an unchanged entry reports no change, and a foreign `openwiki` entry that is not the replaceable one raises a conflict.
