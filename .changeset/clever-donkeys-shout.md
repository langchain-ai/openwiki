---
"openwiki": patch
---

Stop the managed `AGENTS.md` block from claiming that a scheduled GitHub Actions workflow refreshes the wiki unless the repository actually has one. The sentence is now stated only when `.github/workflows/openwiki-update.yml` exists and still declares a `schedule` trigger, and is otherwise left out rather than replaced with a different recurrence claim — OpenWiki cannot see a GitLab CI or Bitbucket Pipelines schedule.
