---
"openwiki": patch
---

The internal link validator no longer stamps valid links whose path is percent-encoded (`release%20notes.md`, `caf%C3%A9.md`) or wrapped in angle brackets (`<release notes.md>`) as broken. It now resolves them to the same file a Markdown renderer opens.
