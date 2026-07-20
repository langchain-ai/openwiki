---
name: migrate-wiki-to-okf
description: Make an existing OpenWiki fully OKF-compliant. Use when any current wiki Markdown files lack valid OKF YAML front matter or when the user requests an OKF migration.
---

# Migrate Wiki to OKF

Add or correct OKF front matter across the existing wiki without changing accurate document bodies.

## Workflow

1. Before editing, recursively inventory every directory under the wiki root. Include the root directory itself.
2. Write a plan listing every discovered directory and its assigned subagent.
3. Spawn exactly one subagent for each directory. If concurrency is limited, run them in batches; never combine multiple directories into one assignment.
4. Give each subagent write access only to Markdown files directly inside its assigned directory. It must not recurse into or modify another directory.
5. Wait for every subagent, then verify that every planned directory was processed. Send missed corrections back to a subagent scoped to that same directory.

## Subagent Task

Each subagent must:

- Inspect every non-reserved Markdown concept file directly in its assigned directory.
- Leave already compliant files unchanged.
- Add or correct only the leading YAML front matter when needed. Preserve the existing Markdown body.
- Preserve all valid existing front matter fields, including `timestamp` and producer-defined extension fields. Never delete an unknown field merely because OpenWiki did not create it.
- Require only a non-empty, descriptive `type`. Infer recommended `title` and one to two sentence `description` values when useful. Add `resource`, `tags`, or `timestamp` only when supported by the document and available evidence.
- Use this standard-field formatter while retaining any existing producer extensions:

```yaml
---
type: <Type name>
title: <Optional display name>
description: <Optional one to two sentence summary (optimized for search & retrieval)>
resource: <Optional canonical URI for the underlying asset>
tags: [<tag>, <tag>]
timestamp: <Optional ISO 8601 datetime>
---
```

- `index.md` and `log.md` are reserved OKF documents. Do not add concept front matter to them or process them as concepts; OpenWiki regenerates directory indexes deterministically after the run.
- Report the files checked, the files changed, and any file whose metadata could not be inferred confidently.
- The description field is important for retrieval tools. When present, make it clear, detailed, and optimized for search.

Do not create, delete, move, or reorganize wiki pages during this migration.
