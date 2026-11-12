---
"openwiki": patch
---

fix: return the pages a checkpoint prune frees to the database

Checkpoint databases created by an earlier version keep the sqlite default
`auto_vacuum = 0`, which sqlite refuses to change once the database has
tables, so a prune on one of them still frees rows without returning the
pages. Those databases now say so on stderr when openwiki starts, with the
one-time `PRAGMA auto_vacuum=INCREMENTAL; VACUUM;` that converts them. The
conversion rewrites the whole file and needs disk for a second copy, so it
is the user's call to run rather than something a run does for them.