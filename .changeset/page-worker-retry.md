---
"openwiki": patch
---

Retry a page worker once before skipping its page. A worker whose stream ends without calling `submit_page` is restarted once from the page's pre-run snapshot, so a transient empty final turn no longer discards the page and forces the next update to re-research the whole changeset. If the retry also exits without submitting, the page is skipped exactly as before.
