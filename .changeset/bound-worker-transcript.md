---
"openwiki": patch
---

Add `OPENWIKI_MAX_INPUT_TOKENS`, which bounds tool results from earlier turns in repository worker transcripts so later turns on update and init do not resend full source file contents.
