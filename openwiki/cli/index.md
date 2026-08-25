# Files

- [CLI Command Parsing & Dispatch](overview.md) - How the openwiki CLI parses argv into a discriminated command, resolves startup guards, decides interactive vs non-interactive rendering, dispatches each command kind including host-integration commands, and routes repository generation through runOpenWikiAgent.
- [CLI Subcommand Runners & Diagnostics](runners.md) - The auth, ngrok, cron, ingest, visualize, integrations, mcp, and print command runners; how print mode mirrors interactive runs through the telemetry boundary; and the non-interactive auth-fix and error diagnostics output.
- [Interactive TUI (Ink)](tui.md) - The Ink terminal application, its finite run lifecycle state machine, and the run-log reducer that folds streamed run events (including repository_progress events) into a bounded progress model of prose, tool summary counts, and exact filesystem activity.
