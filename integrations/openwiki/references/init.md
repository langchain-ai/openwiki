# Initialize OpenWiki

## Contents

- [Goal](#goal)
- [Workflow](#workflow)
- [Coverage check](#coverage-check)

## Goal

Build a durable engineering map from an intent to the owning systems, runtime
flows, files, symbols, focused tests, and operations.

`openwiki_begin` starts init from a blank generated wiki. Prior generated pages,
Claims sidecars, indexes, and run metadata are unavailable; the user-authored
`openwiki/INSTRUCTIONS.md` brief is preserved when present.

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
4. Write the complete proposed structure to `openwiki/_plan.md`. Begin with an
   Information architecture section containing the proposed wiki tree and its
   stable, repository-specific domain taxonomy. Map every substantial component
   and workflow to its canonical page, primary source paths and symbols, focused
   tests, and disposition. Organize around runtime domains, owned subsystems,
   and cross-system workflows; do not mirror the source directory tree.
   Keep the root focused on `quickstart.md` and genuinely repository-wide
   concepts. Group related pages into meaningful domain directories instead of
   leaving a flat collection of Markdown files. Avoid artificial single-page
   directories, generic catch-all sections, and thin landing pages. Each
   quickstart domain containing multiple pages should correspond to the physical
   directory that owns those pages. Do not use umbrella names such as
   `architecture/`, `core/`, or `platform/` to collect independently owned
   subsystems; reserve them for material that genuinely spans those domains. Do
   not force hierarchy onto a genuinely small wiki. Treat every planned page
   path as final: do not draft pages at the root for later reorganization,
   because Claims are owned by their canonical page paths.
5. Read [reviewers.md](reviewers.md), then run the skeleton critic through the
   host's native delegation mechanism. Reviewers are read-only; the main agent
   owns the plan and all wiki edits.
6. Create one TODO for every critic request, revise the plan, then run the
   critic exactly once more with the complete request ledger and resolutions.
   Address any remaining item directly; do not invoke a third critic review. Do
   not begin substantive page research, Claims resolution, or prose authoring
   until every taxonomy request is resolved in the plan and exact final paths
   are frozen. Before then, the main agent owns inventory and plan revision; the
   skeleton critic is the only delegated role. Do not launch standalone domain
   research or evidence-brief subagents during planning.
7. Only after the critic gate, author every planned page. For each factual page,
   complete one domain-local evidence pass by inspecting its entrypoint, primary
   implementation, important types or schemas, state or persistence, an
   upstream caller, a downstream dependency, representative tests, and relevant
   operational or generated contracts. When the host supports delegation,
   assign each coherent domain once to at most nine host-native evidence
   subagents total, with one disjoint set of exact planned paths per invocation.
   Do not create a separate repository-wide evidence-brief phase, delegate the
   same domain twice, or follow a research task with a second authoring/research
   task for that domain. Reuse each returned brief directly; the main agent
   performs only narrow source verification needed to establish Claims, rather
   than repeating the domain inventory. The main agent retains ownership of all
   Claims mutations and factual Markdown edits.
   Establish every material repository-supported proposition with
   `openwiki_resolve_claims`, passing the active `runId`, the page, and bounded
   `repo://path#L10-L24` evidence where practical. Batch multiple pages in one
   call when their evidence is ready. Then write complete explanatory prose
   grounded in those propositions. Explain ownership, behavior, relationships,
   invariants, extension surfaces, failures, focused tests, and primary
   evidence. Do not treat a source map or passing mention as substantive
   coverage. Begin writing once the assigned domain's evidence pass is complete;
   do not wait for a second evidence pass over the complete inventory.
8. Perform an unknown-unknown pass over uncovered manifest-backed or high-ranked
   clusters, one-hop dependencies, and cross-system workflows exposed during
   writing. Expand the plan and wiki for real gaps, applying the same evidence
   and Claims discipline to every added page. Before authoring it, add its exact
   final path to the existing taxonomy and verify that it does not introduce
   root-level sprawl, an artificial single-page directory, or a generic
   catch-all. Never introduce an ad-hoc path absent from the plan.
9. Reconcile the physical wiki tree against the reviewed domain taxonomy and
   inventory. Relocate root-level orphans, collapse unjustified single-page
   directories, split generic umbrellas that mix independently owned
   subsystems, and ensure each multi-page quickstart domain maps to its physical
   directory. Establish the
   complete Claims set for `openwiki/quickstart.md`, then write it last with
   links to every major concept and a compact task-routing map from engineering
   intent to pages, source entrypoints and symbols, focused tests, and narrow
   validation. Its semantic map must match the physical directory hierarchy.
10. Invoke the question finder and create one TODO for every returned question.
11. Batch related questions in groups of two or three and launch verifier batches
    together. For every `PARTIAL` or `FAIL`, reconcile the affected propositions
    through `openwiki_resolve_claims` before repairing Markdown. Complete all
    repairs in a wave before retrying only those IDs. Continue until every
    question passes.
12. Perform a final reconciliation against the reviewed plan, QA TODOs, and
    Claims-backed page set. Keep quickstart links accurate after repairs.
13. Call `openwiki_finish`; it removes the temporary plan and completes
    Claims persistence, deterministic validation, indexing, provenance, and
    metadata.

## Coverage check

Verify that the wiki explains repository purpose, entry points, ownership
boundaries, end-to-end flows, configuration, persistence, focused testing,
operations, and non-obvious security or failure behavior.

Substantial components may be grouped only when their relationship and canonical
home are explicit. Defer an in-scope area only when it is unavailable to inspect
safely, explicitly excluded, or evidence-blocked; record that reason in the
quickstart backlog.
