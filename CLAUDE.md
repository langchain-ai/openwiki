## OpenWiki

This repository has documentation located in the /openwiki directory.

Start here:

- [OpenWiki quickstart](openwiki/quickstart.md)

OpenWiki includes repository overview, architecture notes, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

When working in this repository, read the OpenWiki quickstart first, then follow its links to the relevant architecture, workflow, domain, operation, and testing notes.

<!-- OPENWIKI:START -->

## OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- If implementation ownership, behavioral invariants, analogous tests, or shipped surfaces are unclear, call `openwiki_retrieval.change_surface` once with the task before broad exploration. Inspect its cited source and tests directly; do not reread the returned wiki pages.
- Use `openwiki_retrieval.search` only for a concrete unresolved evidence gap. Reconsult when source contradicts the brief, work enters an uncited subsystem, or an unfamiliar failure reveals a missing contract.
- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Before finishing a public or cross-package change, call `change_surface` with the task and the repository-relative changed paths. Verify relevant flagged exports, registration, generated surfaces, consumer paths, and focused tests.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
