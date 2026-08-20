# Initialize OpenWiki

## Goal

Build a durable engineering map from an intent to the owning systems, runtime
flows, files, symbols, focused tests, and operations.

## Workflow

1. Read repository-level instructions and `.openwikiignore` when present.
2. Inventory top-level source, test, configuration, build, and operations areas.
   Use targeted listing and search; never recursively dump the repository.
3. Identify systems and workflows from imports, symbols, calls, shared data,
   tests, and history. Do not mirror the directory tree.
4. Plan a concise wiki structure in working memory.
5. Investigate primary source and representative tests for each planned page.
6. Create `openwiki/quickstart.md`, then concept pages grouped by domain.
7. Link concepts in sentences that explain their relationships.
8. Add diagrams only when a flow, lifecycle, state machine, or data model is
   materially clearer visually.
9. Read back every authored page and remove unsupported or duplicated material.
10. Call `openwiki_finish` and resolve every actionable validation failure.

## Coverage check

Verify that the wiki explains repository purpose, entry points, ownership
boundaries, end-to-end flows, configuration, persistence, focused testing,
operations, and non-obvious security or failure behavior.
