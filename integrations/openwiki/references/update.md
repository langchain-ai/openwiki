# Update OpenWiki

## Goal

Reconcile documentation with meaningful source changes while preserving accurate
structure and prose that did not change.

## Workflow

1. Use `lastUpdate.gitHead` from `openwiki_begin`, current Git status, and focused
   history or diffs to identify meaningful changes.
2. Ignore generated OpenWiki output and `.openwikiignore` paths when deciding
   which source changes matter.
3. Map changed symbols to their owning pages and adjacent workflows.
4. Read affected pages and their supporting source and tests with native tools.
5. Preserve accurate prose, unknown frontmatter fields, headings, and links.
6. Update obsolete facts, add important new behavior, and remove facts that no
   longer exist.
7. Create or delete a page only when conceptual boundaries genuinely changed.
8. Review every resulting page and call `openwiki_finish`.

If the requested language changes, translate factual pages consistently in the
same run. An interrupted prior run is actionable even when Git is unchanged.
