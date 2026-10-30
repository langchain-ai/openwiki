---
"openwiki": patch
---

Stop a repository worker after five plan or page submissions instead of letting it resubmit a rejected payload until the recursion limit. A page worker that hits the cap is skipped and reconsidered on the next update.
