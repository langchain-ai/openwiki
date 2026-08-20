# Initialize OpenWiki

## Goal

Build a durable engineering map from an intent to the owning systems, runtime
flows, files, symbols, focused tests, and operations.

## Workflow

1. Read repository-level instructions, `openwiki/INSTRUCTIONS.md`, and
   `.openwikiignore` when present.
2. Map the repository before drafting. Inventory manifest-backed components,
   runtime and build entrypoints, public surfaces, major domains, data and state
   ownership, operations, existing docs, and representative tests. Rank areas
   by runtime importance, dependency centrality, public surface, recent change,
   and test ownership.
3. Group files into systems and cross-system workflows using imports, symbols,
   calls, shared data, tests, and history. Do not mirror the directory tree.
4. Write the complete proposed structure to `openwiki/_skeleton.md`. Give every
   substantial component and workflow a canonical page or named substantive
   section, and describe the evidence and content each page must cover.
5. Build an evidence brief for every planned substantive page before drafting.
   Inspect its entrypoint, primary implementation, important types or schemas,
   state or persistence, an upstream caller, a downstream dependency,
   representative tests, and relevant operational or generated contracts.
   Delegate independent briefs in parallel when the host supports it, then have
   the main agent reconcile their evidence before authoring.
6. Read [reviewers.md](reviewers.md), then run the skeleton critic through the
   host's native delegation mechanism. Reviewers are read-only; the main agent
   owns the skeleton and all wiki edits.
7. Create one TODO for every critic request, revise the skeleton, then run the
   critic exactly once more with the complete request ledger and resolutions.
   Address any remaining item directly; do not invoke a third critic review.
8. Only after the critic gate, author every planned page. Explain ownership,
   behavior, relationships, invariants, extension surfaces, failures, focused
   tests, and primary evidence. Do not treat a source map or passing mention as
   substantive coverage.
9. Perform an unknown-unknown pass over uncovered manifest-backed or high-ranked
   clusters, one-hop dependencies, and cross-system workflows exposed during
   writing. Expand the skeleton and wiki for real gaps.
10. Reconcile the final wiki tree against the inventory, then invoke the question
    finder. Create one TODO for every returned question.
11. Batch related questions in groups of two or three and launch verifier batches
    together. Repair all `PARTIAL` and `FAIL` results for a wave before retrying
    only those IDs. Continue until every question passes.
12. Write `openwiki/quickstart.md` last. Link every major concept and include a
    compact task-routing map from engineering intent to pages, source entrypoints
    and symbols, focused tests, and narrow validation.
13. Call `openwiki_finish`; it removes the temporary skeleton and completes
    deterministic validation, indexing, provenance, and metadata.

## Coverage check

Verify that the wiki explains repository purpose, entry points, ownership
boundaries, end-to-end flows, configuration, persistence, focused testing,
operations, and non-obvious security or failure behavior.

Substantial components may be grouped only when their relationship and canonical
home are explicit. Defer an in-scope area only when it is unavailable to inspect
safely, explicitly excluded, or evidence-blocked; record that reason in the
quickstart backlog.
