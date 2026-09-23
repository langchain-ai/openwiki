---
"openwiki": minor
---

Code mode no longer creates `CLAUDE.md`, since Claude Code reads `AGENTS.md` when no `CLAUDE.md` exists. An existing `CLAUDE.md` still gets its managed block, and the generated update workflow adds `CLAUDE.md` to the pull request only when the file exists.
