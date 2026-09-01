---
"openwiki": patch
---

Fix `.env` values with a backslash immediately followed by `n` or `r` (e.g. Windows paths like `C:\name\creds.json`) being corrupted with a stray newline or carriage return on load.
