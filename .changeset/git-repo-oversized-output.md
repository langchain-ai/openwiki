---
"openwiki": patch
---

fix: the `git-repo` connector no longer skips a repository forever when the git output since the last ingest is larger than 1 MiB. Each list in the manifest is capped at 1000 lines and 256 KiB and marked with a `*Truncated` flag, so the recorded head advances.
