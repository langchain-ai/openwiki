---
type: Reference
title: Scheduling & Scheduled Updates
description: How OpenWiki validates cron expressions, installs macOS launchd schedules for personal ingestion, and drives code-mode scheduled updates through CI workflows.
tags: [scheduling, cron, launchd, ci, operations]
sources:
  - id: openwiki-source-dddc6b85a4725b9edbba5f88
    resource: repo://examples/openwiki-update.yml
  - id: openwiki-source-85064d6a188fa56bcc282f11
    resource: repo://src/ingestion/code-mode.ts
  - id: openwiki-source-c923e23504de7a6af7799a24
    resource: repo://src/scheduling/schedules.ts
generated: { by: "openwiki/0.3.3", at: "2026-08-22T08:02:55.052Z" }
verified:
  - by: openwiki/0.3.3
    at: 2026-08-22T08:02:55.052Z
---

# Scheduling & Scheduled Updates

OpenWiki keeps a wiki current on a schedule in two different ways: **personal ingestion** is scheduled natively via macOS launchd, and **code-mode updates** are scheduled through a CI workflow committed to the repository.

## Cron validation

Cron expressions are validated and described using cron-parser and cronstrue, rejecting an empty or unparseable expression. The suggested expression comes from the saved ingestion schedule or defaults to a daily early-morning run.

## Native (macOS launchd) schedules

Native schedule installation is **macOS-only**, via a launchd LaunchAgent:

```mermaid
flowchart TD
    Start["installConnectorSchedule"] --> Valid{"cron valid?"}
    Valid -- no --> Err["throw"]
    Valid -- yes --> OS{"darwin?"}
    OS -- no --> Warn1["save with warning (macOS-only)"]
    OS -- yes --> Cal{"launchd calendar<br/>interval parseable?"}
    Cal -- no --> Warn2["save with warning (too complex)"]
    Cal -- yes --> Write["write 0600 plist to LaunchAgents"]
    Write --> Load["launchctl bootstrap"]
```

_Native schedule installation._

On non-darwin platforms the schedule is saved with a warning, and a cron expression too complex for a launchd calendar interval is also saved with a warning instead of installed. Installing writes a launchd plist with `0600` permissions into the LaunchAgents directory, propagates the OpenWiki config-dir override, then reloads it via `launchctl bootstrap`.

## Code-mode scheduled updates

Code-mode scheduled updates are driven by a **GitHub Actions workflow**, not launchd. `init` generates `openwiki-update.yml` with a daily cron, and equivalent example workflows exist for GitLab CI and Bitbucket Pipelines under `examples/`.

For how the workflow is created and preserved, see [ingestion/overview.md](../ingestion/overview.md).
