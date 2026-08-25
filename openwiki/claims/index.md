# Files

- [Claims Agent Integration](agent-integration.md) - How Grounded Claims are submitted during repository generation — the submit_page tool, the replacePageClaims diff algorithm, the Claims session resolveClaims method, and how page completion triggers Claims persistence.
- [Claims Evidence (repo:// Resources)](evidence.md) - The repository evidence namespace behind Grounded Claims — repo:// resource identities, whole-file and line-range versioning, anchor-based range relocation, and the containment and symlink security boundary.
- [Grounded Claims Overview](overview.md) - How OpenWiki grounds material facts in versioned source evidence, the add/confirm/update/retract lifecycle, staleness detection, and the per-page .claims sidecar layout for code wikis.
- [Claims Runtime & Store](runtime-and-store.md) - How OpenWiki prepares a run-scoped Claims runtime, persists per-page sidecars atomically, applies atomic claim mutations, caches evidence resolution per phase, runs preflight staleness detection, and finalizes with verification projection and hash refresh for code wikis.
