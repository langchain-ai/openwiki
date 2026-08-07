---
"openwiki": patch
---

fix: emit relative markdown links so every renderer resolves them

Generated page bodies used root-relative links (`/openwiki/page.md`, `/src/foo.ts`) that no renderer resolves. Page bodies are now required to use paths relative to the linking file, the validator stamps any root-relative destination so the next update repairs it, and the visualizer graph resolves leftover root-relative links instead of dropping their edges.
