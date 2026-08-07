import type {
  OpenWikiCommand,
  OpenWikiOutputMode,
  OpenWikiRunOptions,
} from "../agent/types.js";
import { getConfiguredConnectorIds } from "../connectors/registry.js";
import type { OpenWikiProvider } from "../config/constants.js";

import { recordRun } from "./senders.js";
import type {
  TelemetryErrorClass,
  TelemetryErrorOwner,
  TelemetryErrorStage,
} from "./types.js";

/**
 * Translates a finished agent run into the single telemetry event and records
 * it. This is the one bridge between the run lifecycle and telemetry:
 *
 * - Chat is dropped (it is interactive and would emit an event per turn), so
 *   only init and update ever produce an `openwiki_run` event.
 * - The agent's output mode is mapped to the brain `mode`.
 * - The setup fields (mode, provider, connectors) are attached on **init only**
 *   (the configuration moment); updates omit them.
 * - The `--telemetry-file` tee target is forwarded through.
 *
 * Like {@link recordRun}, it never throws.
 *
 * @param command - Which run lifecycle finished. Only init/update are recorded.
 * @param options - The run options; read for `outputMode` and `telemetryFile`.
 * @param facts - What the run produced: its `outcome`, the failure diagnostics
 *   (`errorClass`, plus an optional `errorDetail`, `errorOwner`, `errorStage`, and
 *   `httpStatus`, all present only on failure), and the resolved `provider` (which
 *   may be undefined when resolution failed before the provider was known).
 */
export async function recordRunSafe(
  command: OpenWikiCommand,
  options: OpenWikiRunOptions,
  facts: {
    provider?: OpenWikiProvider;
    outcome: "success" | "failure" | "noop";
    errorClass?: TelemetryErrorClass;
    errorDetail?: string;
    errorOwner?: TelemetryErrorOwner;
    errorStage?: TelemetryErrorStage;
    httpStatus?: number;
  },
): Promise<void> {
  // Chat is deliberately not recorded: it is interactive and would emit one
  // event per turn.
  if (command !== "init" && command !== "update") {
    return;
  }

  const outputMode: OpenWikiOutputMode = options.outputMode ?? "local-wiki";

  await recordRun({
    command,
    outcome: facts.outcome,
    errorClass: facts.errorClass,
    errorDetail: facts.errorDetail,
    errorOwner: facts.errorOwner,
    errorStage: facts.errorStage,
    httpStatus: facts.httpStatus,
    // Setup choices are captured on init only (the configuration moment); on
    // updates these are omitted entirely.
    ...(command === "init"
      ? {
          mode: outputMode === "repository" ? "code" : "personal",
          provider: facts.provider ?? "unknown",
          configuredConnectors: getConfiguredConnectorIds(),
        }
      : {}),
    telemetryFile: options.telemetryFile,
  });
}
