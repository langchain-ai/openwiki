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

- Inspect every non-generated Markdown file directly in its assigned directory.
- Leave already compliant files unchanged.
- Add or correct only the leading YAML front matter when needed. Preserve the existing Markdown body.
- Use a descriptive, self-explanatory `type`. Infer `title` and a one to two sentence `description` (this should be optimized for search & retrieval) from the document when useful. Add `resource` or `tags` only when supported by the document.
- Never add `timestamp` or fields outside this formatter:

```yaml
---
type: <Type name>
title: <Optional display name>
description: <Optional one to two sentence summary (optimized for search & retrieval)>
resource: <Optional canonical URI for the underlying asset>
tags: [<tag>, <tag>]
---
```

- Do not edit `index.md`; OpenWiki regenerates directory indexes deterministically after the run.
- Report the files checked, the files changed, and any file whose metadata could not be inferred confidently.
- The description field here is very important as retrieval tools will rely on it when searching through documents. Ensure your descriptions are clear, detailed, and optimized for search.

Do not create, delete, move, or reorganize wiki pages during this migration.
