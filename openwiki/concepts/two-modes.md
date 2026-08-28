---
type: concept
title: Code vs Personal Modes
description: How OpenWiki chooses between code mode (a repository wiki written to openwiki/) and personal mode (a knowledge brain written to ~/.openwiki/wiki), including mode selection, state directories, and which capabilities apply to each mode.
tags: [modes, cli, configuration, repository-wiki, personal-wiki, output-mode]
verified:
  - by: openwiki/0.3.3
    at: 2026-08-25T02:14:25.283Z
sources:
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-12c17ed8ca9c89ec61f28df7
    resource: repo://src/agent/docs-only-backend.ts
  - id: openwiki-source-8bf337d8927152d7d30230b4
    resource: repo://src/agent/prompt.ts
  - id: openwiki-source-5d1891104d4c886504a5cc7d
    resource: repo://src/agent/types.ts
  - id: openwiki-source-69abc6f0f641147820a274bc
    resource: repo://src/agent/utils.ts
  - id: openwiki-source-3fc16f0371ced4d94330f06c
    resource: repo://src/cli/commands.ts
  - id: openwiki-source-8d81ffb5996861d05633851c
    resource: repo://src/cli/run-mode.ts
  - id: openwiki-source-7d433875b0854d0b8b951be0
    resource: repo://src/config/openwiki-home.ts
  - id: openwiki-source-01c7d07d9800df0261f20efb
    resource: repo://src/connectors/tools.ts
  - id: openwiki-source-c6189f89b3f67d0cbf87739f
    resource: repo://src/ingestion/ingestion.ts
generated: { by: "openwiki/0.3.3", at: "2026-08-25T02:14:25.283Z" }
---

# Code vs Personal Modes

OpenWiki runs in exactly one of two modes per invocation. **Code** mode documents
the current repository and writes the generated wiki into `openwiki/` inside that
repository. **Personal** mode maintains a personal knowledge brain from connected
sources and writes it into the local wiki directory under the OpenWiki home
(`~/.openwiki/wiki` by default). The mode chosen at parse time flows through the
run as an internal _output mode_ that determines the working directory, the wiki
layout, which tools are available, and whether grounded Claims apply.

## Two run modes and their internal output mode

The user-facing selector is `OpenWikiRunMode`, which is either `"personal"` or
`"code"`. Every parsed `run` command carries both the resolved `mode` and a
`modeSource` recording how that mode was chosen (`default`, `option`, or
`positional`).

Internally, the run mode is mapped to an `OpenWikiOutputMode`
(`"local-wiki" | "repository"`): `code` maps to `repository` and `personal` maps
to `local-wiki`. This output mode is the value that the agent, prompts,
finalizer, and backends branch on.

```mermaid
flowchart TD
  CLI["CLI args"] --> Parse["parseCommand / parseRunCommand"]
  Parse -->|"mode + modeSource"| RunMode{"OpenWikiRunMode"}
  RunMode -->|"code"| CodeOut["outputMode = repository"]
  RunMode -->|"personal"| PersOut["outputMode = local-wiki"]
  CodeOut --> CodeCwd["cwd = repository root (process.cwd)"]
  PersOut --> PersCwd["cwd = ~/.openwiki/wiki"]
  CodeOut --> CodeLayout["wiki under /openwiki, grounded Claims, docs-only writes"]
  PersOut --> PersLayout["wiki at root, connector tools enabled"]
```

## Default mode selection

Mode resolution happens entirely at argument-parse time. `parseCommand`
dispatches to `parseRunCommand`. When the first argument is a mode word
(`personal` or `code`), it is consumed as a positional mode with source
`positional`; otherwise parsing begins with `code` as the default mode and source
`default`.

Bare `openwiki`, `openwiki --init`, and `openwiki --update` therefore run in
`code` mode. In addition, when an `init` or `update` command is requested and the
mode is still at its `default` source, the parser explicitly pins the mode to
`code`. To operate on the personal brain, add the `personal` positional (for
example `openwiki personal --init`) or pass `--mode personal`.

## The personal positional and the --mode flag

There are two ways to request a non-default mode:

- **Positional mode word.** A mode word in the first positional slot selects the
  mode even when flags precede it (for example `openwiki --print code --update`).
  This positional handling is deliberate: without it the mode word would be
  treated as the user message and the run would silently target the default
  personal-style wiki.
- **`--mode <personal|code>` flag.** The flag (and its `--mode=` form) validates
  the value and sets the mode with source `option`. An unrecognized value fails
  with `Invalid mode: ...`.

Mode requests must be consistent. `resolveExplicitMode` rejects a second explicit
mode that conflicts with an already-explicit one, producing a `Conflicting modes`
error; a request that merely repeats the current mode, or that overrides a
still-`default` mode, is accepted.

## Working directory and wiki layout differ by mode

The resolved mode drives where the run reads and writes:

- **Working directory.** `getRunModeCwd` returns the code runtime's cwd
  (`process.cwd()` by default) in `code` mode, and the local wiki directory
  (`openWikiLocalWikiDir`) in `personal` mode.
- **Wiki content root.** In `repository` output mode the generated wiki lives
  under the `openwiki/` subdirectory of the repository; in `local-wiki` output
  mode the wiki _is_ the root of the local wiki directory, with pages written
  directly under `/` (no nested `/openwiki` directory).

The agent prompt reflects this: in `local-wiki` mode the virtual `/` root is the
local wiki directory and pages are written at the root, while in `repository`
mode `/` is the repository root and the wiki lives under `/openwiki`.

## Capabilities that apply to code mode only

Several capabilities are gated on `outputMode === "repository"` and therefore
apply to code repository wikis only:

- **Docs-only write boundary.** Repository init/update runs may only write under
  `openwiki/`; writes escaping that tree are refused. In `local-wiki` mode the
  docs-only check is relaxed and writes are allowed.
- **Grounded Claims ownership.** Repository Claims state is
  implementation-owned: writes into the Claims state paths are refused, and shell
  `execute` commands that reference Claims state are rejected. This ownership
  boundary is applied only in `repository` output mode.
- **Host-driven (coding-agent) runs.** Running OpenWiki inside Codex, Claude
  Code, or OpenCode currently supports repository code wikis, not personal
  brains, and uses only repository source and tests as context.

## Capabilities that apply to personal mode only

Connector ingestion tools are a personal/local-wiki capability. When the output
mode is `repository`, `createOpenWikiConnectorTools` returns no tools at all,
because a code-mode run documents a codebase and must never be handed connector
ingestion. Personal ingestion runs (see the ingestion pipeline) always run
against the local wiki directory as their working directory and use the
`local-wiki` output mode.

## Local state directory and the OPENWIKI_CONFIG_DIR override

The personal wiki, credentials, connector data, conversation history, and skills
all live under the OpenWiki home directory. `resolveOpenWikiHomeDir` returns
`~/.openwiki` by default, but honors the `OPENWIKI_CONFIG_DIR` environment
variable when it is set, expanding a leading `~` and resolving relative paths.
For example:

```sh
OPENWIKI_CONFIG_DIR=/data/openwiki openwiki personal --init
```

The override simply selects a different state directory; OpenWiki does not move or
copy an existing `~/.openwiki`. `ensureOpenWikiHome` creates the home and its
subdirectories (`connectors`, `conversation_history`, `wiki`, `skills`) with
owner-only `0o700` permissions and restricts the home to the current user, so the
target should be a dedicated, writable directory such as a mounted container
volume. The personal wiki directory itself is always the `wiki` subdirectory of
whichever home directory is in effect.

## Related pages

- [Architecture overview](/openwiki/architecture/overview.md)
- [Configuration](/openwiki/operations/configuration.md)
- [Personal ingestion workflow](/openwiki/workflows/personal-ingestion.md)
- [Repository generation workflow](/openwiki/workflows/repository-generation.md)
