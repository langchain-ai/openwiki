---
"openwiki": minor
---

feat(scheduling): add Windows Task Scheduler backend

Adds a native Windows scheduler surface (#421) that slots into the
platform-neutral seams introduced by #758:

- `parseSchtasksTriggerArgs()` — pure cron → `schtasks` trigger translation
  (daily/weekly/monthly; rejects ranges, steps, lists, and cron semantics
  `schtasks` can't AND, e.g. day-of-month + weekday together)
- `installConnectorSchedule` on `win32` writes an `ingestion.schedule.cmd`
  shim (cd into the repo, run `ingest all --scheduled`) and registers it via
  `schtasks /Create`
- `listConnectorSchedules` reports install state from `schtasks /Query`
- `pauseConnectorSchedules` / `deleteConnectorSchedules` remove the task and
  shim

All shell-outs use an explicit argv array (no `shell: true`), so repo or
config values can't be reinterpreted as shell syntax. Non-`win32` platforms
fall through to the existing behavior; the win32 path is fully covered by
`schedules-schtasks.test.ts` (which stubs `process.platform`).
