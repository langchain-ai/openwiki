---
"openwiki": patch
---

Keep a wiki page's front matter when it repeats a top-level key, such as two `verified` blocks left by a Git merge. The last occurrence now wins and every other field is preserved, instead of the whole block being replaced by a minimal generated one.
