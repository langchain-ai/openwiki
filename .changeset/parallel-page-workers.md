---
"openwiki": minor
---

feat: run repository page workers in parallel with `OPENWIKI_PAGE_CONCURRENCY`

Repository `init` and `update` runs can now document several pages at once. Set `OPENWIKI_PAGE_CONCURRENCY` to an integer from 1 to 8 (default 1, unchanged behavior) to run that many page workers concurrently. Each worker still owns exactly one page, the quickstart page is written last, and every page stays a durable resume unit. When a worker fails on a provider rate limit the run lowers its concurrency by one, and runs with more than one worker default to five model retry attempts unless `OPENWIKI_PROVIDER_RETRY_ATTEMPTS` is set. The progress line reports completed pages and the pages in flight when more than one worker is active.
