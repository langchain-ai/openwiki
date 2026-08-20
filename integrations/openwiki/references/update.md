# Update OpenWiki

## Goal

Reconcile documentation with meaningful source changes while preserving accurate
structure and prose that did not change.

## Workflow

1. Read repository-level instructions, `openwiki/INSTRUCTIONS.md`, the existing
   quickstart and backlog, and `.openwikiignore` when present.
2. Use `lastUpdate.gitHead` and `updatePreflight` from `openwiki_begin`, current
   Git status, and focused history or diffs to identify meaningful changes.
   Ignore generated OpenWiki output and ignored paths.
3. When `updatePreflight.shouldSkip` is `true` and the user requested only a
   routine refresh, do not investigate or author files; call `openwiki_finish`
   immediately. Continue when the user requested a specific repair or scope.
4. Map changed symbols to owning systems, existing pages, one-hop dependencies,
   and adjacent workflows. Rebuild the full repository inventory only for
   structural changes or an obvious existing coverage gap.
5. Before drafting, write `openwiki/_plan.md`. For every affected or newly
   discovered component and workflow, record the target page and section,
   primary source anchors, relationships, required edit, and one disposition:
   `covered`, `grouped`, `out of scope`, or `evidence-blocked`.
6. Rank affected areas by runtime importance, dependency centrality, public
   surface, recent change, and test ownership. Read each affected page plus its
   primary implementation, callers, dependencies, and representative tests.
7. Revisit the plan after discovery. Resolve contradictions and add newly
   exposed systems, workflows, or relationships before writing final prose.
8. Preserve accurate structure, prose, headings, links, and unknown frontmatter
   fields. Replace obsolete facts, add important new behavior, and remove facts
   that no longer exist. Create or delete pages only when conceptual boundaries
   genuinely changed.
9. Inspect uncovered one-hop dependencies and adjacent workflows revealed by
   drafting. Expand the impact plan only for real gaps; do not rescan or rewrite
   unrelated, accurate systems.
10. Revisit the plan after drafting and reconcile every item against the final
    edits. Read back changed pages and verify source grounding, terminology,
    navigation, relationships, focused tests, and failure behavior.
11. Call `openwiki_finish`; it removes the temporary plan and completes
    deterministic validation, indexing, provenance, and metadata.

If the requested language changes, translate factual pages consistently in the
same run. An interrupted prior run is actionable even when Git is unchanged.
Work in the main agent by default. For a broad update spanning independent
documentation areas, delegate bounded evidence or review tasks when parallelism
materially helps. Keep the impact plan and all factual edits in the main agent.
