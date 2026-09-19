---
"openwiki": patch
---

fix: replace a legacy unmarked `## OpenWiki` section in AGENTS.md and CLAUDE.md instead of appending a second one beside it. Repositories set up by a pre-marker release had a bare `## OpenWiki` section that code mode never reconciled, so each run left the old section sitting next to the managed block. Code mode now removes that old section and puts the managed block where it was, preserving any content edited in below it.
