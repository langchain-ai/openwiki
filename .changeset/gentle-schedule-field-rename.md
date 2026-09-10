---
"openwiki": minor
---

refactor(scheduling): generalize launchd-named schedule fields to platform-neutral names

Renames the launchd-specific schedule identifiers to platform-neutral ones so a
non-macOS scheduler backend can reuse the existing seams (#421):

- `ScheduleInstallResult.launchAgentPath` -> `nativeJobPath`
- `ConnectorScheduleStatus.launchAgentLoaded` -> `nativeJobInstalled`
- `ConnectorScheduleStatus.launchAgentPlistExists` -> `nativeJobPathExists`
- `OnboardingSourceScheduleConfig.launchAgentPath` -> `nativeJobPath` (legacy
  `launchAgentPath` key is still read and migrated by `normalizeSourceScheduleConfig`)

CLI status output labels change from `Launchd`/`Plist` to `Scheduler`/`Job file`.
No behavior change on macOS: the launchd implementation, plist writing, and
`launchctl` invocations are untouched. The deprecated `launchAgentPath` field
remains on the type for one release.
