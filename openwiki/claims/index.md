# Files

- [Claims Agent Integration](agent-integration.md) - How the Grounded Claims subsystem is exposed to the documentation agent — the resolve_claims, inspect_claims, and delete_file tools, the lazy read-note middleware, and how they are wired into the DeepAgent graph.
- [Claims Evidence (repo:// Resources)](evidence.md) - The repository evidence namespace behind Grounded Claims — repo:// resource identities, whole-file and line-range versioning, anchor-based range relocation, and the containment and symlink security boundary.
- [Grounded Claims Overview](overview.md) - How OpenWiki grounds material facts in versioned source evidence, the add/confirm/update/retract lifecycle, staleness detection, and the per-page .claims sidecar layout for code wikis.
- [Claims Runtime & Store](runtime-and-store.md) - How OpenWiki prepares a run-scoped Claims runtime, persists per-page sidecars, applies atomic claim mutations, caches evidence resolution, and runs preflight staleness detection for code wikis.
