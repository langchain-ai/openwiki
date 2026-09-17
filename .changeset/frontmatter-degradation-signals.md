---
"openwiki": patch
---

fix: surface pages left with code-derived frontmatter or no description after index sync

`synchronizeWikiIndexes()` now returns a `WikiFrontmatterReport` listing which
pages still carry `openwiki_generated: true` (metadata `type`/`title` was
code-derived rather than authored) and which pages have no usable
`description`, so an operator can see a run produced degraded metadata
instead of it being committed silently. Neither signal changes
`validateOkfFrontmatter()` or `repairOkfFrontmatter()` - `description` is
still never fabricated.
