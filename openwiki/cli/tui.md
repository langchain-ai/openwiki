---
type: Reference
title: Interactive TUI (Ink)
description: The Ink terminal application, its finite run lifecycle state machine, and the run-log reducer that folds streamed run events into a bounded progress model of prose, tool summary counts, and exact filesystem activity.
tags: [cli, tui, ink, run-log, reducer]
sources:
  - id: openwiki-source-5f52dc71fb07ef4892914c46
    resource: repo://src/cli/app/app.tsx
  - id: openwiki-source-e35a9545d3e29bfa4f2af4c1
    resource: repo://src/cli/app/run-state.ts
  - id: openwiki-source-e4ec1fca2618600753c2eec7
    resource: repo://src/cli/input/menu.ts
  - id: openwiki-source-24b29a3a3f5a64c0fe376c76
    resource: repo://src/cli/process-interrupt.ts
  - id: openwiki-source-5533fa23fc222780d009da1b
    resource: repo://src/cli/run-log/activity.ts
  - id: openwiki-source-093863c0390c8bcc175fd22b
    resource: repo://src/cli/run-log/reducer.ts
  - id: openwiki-source-255f033cff7128d036c5815a
    resource: repo://src/cli/run-log/summary.ts
  - id: openwiki-source-80451f737481427280452b95
    resource: repo://src/cli/run-log/types.ts
generated: { by: "openwiki/0.3.3", at: "2026-08-22T08:02:55.052Z" }
verified:
  - by: openwiki/0.3.3
    at: 2026-08-22T08:02:55.052Z
---

# Interactive TUI (Ink)

When a TTY is available the CLI renders an Ink application (`app/app.tsx`) instead of print mode. The app hosts chat input, a run view, and a header, and it consumes the same `OpenWikiRunEvent` stream a print run does — but folds it into a live, bounded progress model rather than raw text.

## Run lifecycle state

The app tracks a finite `RunState`, where each variant carries exactly the data its render branch needs.

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> running: init/update/chat
    idle --> ingestion_running: ingest
    idle --> init_setup_saved: onboarding
    running --> success
    running --> error
    ingestion_running --> ingestion_success
    ingestion_running --> error
    success --> [*]
    error --> [*]
```

_App run lifecycle; states omit the credential-diagnostics carried alongside them._

Opt-in credential diagnostics (from `--debug`) are folded into a live run only while it is still `running`; a late diagnostics resolution can never resurrect a settled run.

## The run-log reducer

`appendRunLogEvent` folds each run event into a bounded `RunLogItem[]`:

- **Main-agent prose** is kept as a single replaceable text buffer; **subgraph prose is discarded**, and empty text is ignored.
- A **`tool_start`** discards any earlier prose — a later tool call proves that prose was narration, not the final answer — and updates the single aggregate tool summary counters (actions, reads, searches, tasks, writes, errors).
- Filesystem tool calls contribute **exact path activity** entries (read/search/write, scoped `openwiki` vs `repository`) without exposing the tool transcript.
- **Debug** items are retained only when opted in and are capped, evicting the oldest beyond the limit.

This makes the live view show _what the agent is doing to which files_, plus counts, rather than a scrolling transcript. Activity paths are merged into a compact tree via shared ancestry.

## Relationship to the run

The TUI is one of two render paths (the other is [print mode](runners.md)); both consume the events produced by [runOpenWikiAgent](../agent/overview.md). Diagnostic text shown in the log is sanitized before display (see [../reference/platform.md](../reference/platform.md)).
