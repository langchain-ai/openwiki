# Files

- [CI Scheduling and Self-Update](ci-scheduling.md) - How OpenWiki runs scheduled self-updates on GitHub Actions, GitLab CI, and Bitbucket Pipelines to open a docs pull request on change, how the scheduling module parses and manages cron expressions, and the ephemeral-runner resume caveat.
- [CLI Commands and Flags](cli-reference.md) - Reference for the OpenWiki CLI surface, covering command and flag parsing, run mode selection, print versus interactive dispatch, host integrations, visualize, cron scheduling, and how parsed commands are wired to their runners.
- [Configuration and Environment](configuration.md) - How OpenWiki loads, resolves, and persists configuration through environment variables and the ~/.openwiki state directory, including secret sanitization, atomic env writes, and provider/token/reasoning settings.
- [Telemetry and Diagnostics](telemetry.md) - How OpenWiki's opt-out telemetry pipeline emits a single anonymous run event per init/update run, how failures are classified into a closed error taxonomy, and how secrets and PII are kept out of the payload before it is sent to PostHog.
