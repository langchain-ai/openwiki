#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { installCrashGuard } from "../agent/crash-guard.js";
import { loadOpenWikiEnv } from "../config/env.js";
import { firstRunNoticePending } from "../telemetry/index.js";
import {
  commandEmitsTelemetry,
  parseCommand,
  shouldRunNonInteractively,
} from "./commands.js";
import {
  FirstRunNotice,
  renderFirstRunNoticeText,
} from "./components/first-run-notice.js";
import { shouldPrintStartupError } from "./run-mode.js";
import { resolveStartupCommand } from "./startup.js";
import { App } from "./app/app.js";
import {
  runAuthCommand,
  runCronCommand,
  runIngestCommand,
  runNgrokCommand,
  runPrintCommand,
  runVisualizeCommand,
} from "./runners.js";

// Register the last-resort handlers before any run starts, so a rejection that
// escapes every catch (e.g. a subagent error surfacing on the microtask queue) is
// recorded and stamped instead of hard-killing the process with no telemetry.
installCrashGuard();

const argv = process.argv.slice(2);
const parsedCommand = parseCommand(argv);

if (
  (parsedCommand.kind === "run" && !parsedCommand.dryRun) ||
  parsedCommand.kind === "auth" ||
  parsedCommand.kind === "cron" ||
  parsedCommand.kind === "ingest" ||
  parsedCommand.kind === "ngrok"
) {
  await loadOpenWikiEnv();
}

const command = await resolveStartupCommand(parsedCommand, {
  cwd: process.cwd(),
  isStdinTTY: Boolean(process.stdin.isTTY),
});

// Decide once, before any event is sent, whether this is the first run on this
// machine (mints the install id). False when suppressed (opt-out or CI) or after
// the first run. How it is shown depends on the render path below.
let showFirstRunNotice = false;
if (commandEmitsTelemetry(command)) {
  showFirstRunNotice = await firstRunNoticePending();
}

if (command.kind === "run" && command.languageWarning) {
  // stderr keeps piped stdout clean while still warning about an ignored locale.
  process.stderr.write(`${command.languageWarning}\n`);
}

if (command.kind === "auth") {
  await runAuthCommand(command);
} else if (command.kind === "ngrok") {
  await runNgrokCommand(command);
} else if (command.kind === "cron") {
  await runCronCommand(command);
} else if (command.kind === "ingest") {
  await runIngestCommand(command);
} else if (command.kind === "visualize") {
  await runVisualizeCommand(command);
} else if (shouldPrintStartupError(argv, parsedCommand, command)) {
  process.stderr.write(`${command.message}\n`);
  process.exitCode = command.exitCode;
} else if (shouldRunNonInteractively(command, process.stdin.isTTY === true)) {
  // Non-TTY / print mode: framed text on stderr so piped stdout stays clean;
  // gray only when stderr is a real terminal.
  if (showFirstRunNotice) {
    console.error(renderFirstRunNoticeText(process.stderr.isTTY === true));
  }
  await runPrintCommand(command);
} else {
  // Interactive TUI: render the notice as a box above the app so it matches
  // the rest of the interface.
  render(
    <>
      {showFirstRunNotice ? <FirstRunNotice /> : null}
      <App command={command} />
    </>,
  );
}
