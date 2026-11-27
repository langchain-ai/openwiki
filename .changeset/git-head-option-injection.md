---
"openwiki": patch
---

Only accept a full Git object id as a recorded `gitHead` in `openwiki/.page-manifest.json` and `.last-update.json`, so a tampered value can no longer be passed to `git diff` as an option.
