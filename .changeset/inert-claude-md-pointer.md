---
"openwiki": patch
---

The managed CLAUDE.md block now imports AGENTS.md with `@AGENTS.md` instead of linking to it. Claude Code expands only its own `@path` import syntax, and it reads AGENTS.md on its own only when no CLAUDE.md sits beside it, so the previous Markdown link left the block inert and the OpenWiki instructions never reached Claude Code. Repositories where CLAUDE.md is a link to AGENTS.md keep the instructions inline, since an import there would point the file at itself.
