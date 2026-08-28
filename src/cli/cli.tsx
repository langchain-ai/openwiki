#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { installCrashGuard } from "../agent/crash-guard.js";
import { loadOpenWikiEnv } from "../config/env.js";
import { firstRunNoticePending } from "../telemetry/index.js";
import {
  commandLoadsEnvironment,
  commandEmitsTelemetry,
  parseCommand,
  shouldRunNonInteractively,
  type CliCommand,
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
import { runIntegrationsCommand, runMcpCommand } from "./integrations.js";

/**
 * Commands handled by the native OpenWiki startup and rendering pipeline.
 */
type StandardCliCommand = Exclude<
  CliCommand,
  { kind: "integrations" } | { kind: "mcp" }
>;

// Register the last-resort handlers before any run starts, so a rejection that
// escapes every catch (e.g. a subagent error surfacing on the microtask queue) is
// recorded and stamped instead of hard-killing the process with no telemetry.
installCrashGuard();

const argv = process.argv.slice(2);
const parsedCommand = parseCommand(argv);

if (parsedCommand.kind === "integrations") {
  await runIntegrationsCommand(parsedCommand);
} else if (parsedCommand.kind === "mcp") {
  await runMcpCommand(parsedCommand);
} else {
  await runStandardCommand(parsedCommand);
}

/**
 * Runs commands that use the native OpenWiki model and application surfaces.
 *
 * @param parsedCommand - Parsed command outside the host-integration surface.
 */
async function runStandardCommand(
  parsedCommand: StandardCliCommand,
): Promise<void> {
  if (commandLoadsEnvironment(parsedCommand)) {
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
      { exitOnCtrlC: false },
    );
  }
}
