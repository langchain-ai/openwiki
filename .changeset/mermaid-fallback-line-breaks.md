---
"openwiki": patch
---

Without the optional `mermaid` and `jsdom` packages, OpenWiki validates diagrams with a built-in check. That check no longer converts a diagram to a text fence because a label has a `<br>` line break or an arrow such as `->`. It also ignores a `<` that is not followed by a letter or `/`, as in `n < 3`. It still converts a diagram that has an HTML-like tag such as `Promise<User>` inside brackets.
