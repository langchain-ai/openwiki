---
"openwiki": patch
---

fix: exit non-zero from `--print` runs that skipped pages, so CI and scripts can detect a run recorded as `interrupted`, and name the worker error behind each skipped page
