---
"openwiki": patch
---

Fix `.last-update.json` being written non-atomically, which could leave it truncated/corrupted under a failed or concurrent write and silently discard the crash guard's interrupted-status signal.
