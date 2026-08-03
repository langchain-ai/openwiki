---
"openwiki": patch
---

fix: warn and back up before replacing custom content in AGENTS.md and CLAUDE.md

OpenWiki now detects when a repo's `AGENTS.md` or `CLAUDE.md` has custom content inside its managed `<!-- OPENWIKI:START -->…<!-- OPENWIKI:END -->` block. Before refreshing, it saves the file to `<file>.openwiki.bak` and prints a warning naming the file and the backup path. Canonical blocks are left untouched (no rewrite, no backup), and malformed markers still abort without changing either file. The scheduled-update workflow now includes the backups in its pull request so CI users can recover replaced content.
