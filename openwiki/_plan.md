---
type: Migration Plan
title: OKF metadata migration plan
description: Directory-scoped plan for adding valid OKF front matter while preserving existing documentation bodies.
tags: [openwiki, okf, migration]
---

# OKF metadata migration plan

This migration preserves existing Markdown bodies and only adds or corrects leading OKF YAML front matter. `index.md` files, if any, are not edited.

| Directory                | Assigned subagent          | Direct Markdown files              |
| ------------------------ | -------------------------- | ---------------------------------- |
| `/openwiki`              | root-wiki-metadata         | `quickstart.md`, `INSTRUCTIONS.md` |
| `/openwiki/agent`        | agent-wiki-metadata        | `workflow.md`                      |
| `/openwiki/architecture` | architecture-wiki-metadata | `overview.md`                      |
| `/openwiki/cli`          | cli-wiki-metadata          | `usage.md`                         |
| `/openwiki/integrations` | integrations-wiki-metadata | `connectors.md`                    |
| `/openwiki/operations`   | operations-wiki-metadata   | `credentials-and-updates.md`       |

`INSTRUCTIONS.md` is user-authored control metadata and is excluded from modification. `_plan.md` is temporary and will be removed after verification.
