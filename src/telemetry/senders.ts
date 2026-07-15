import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { capture } from "./client.js";
import { DEFAULT_POSTHOG_HOST, TELEMETRY_RUN_EVENT } from "./config.js";
import {
  ciSentinelId,
  isCiEnvironment,
  isProductionBuild,
  isTelemetryDisabled,
} from "./gates.js";
import { getOrCreateInstallId } from "./install-id.js";
import type { RunTelemetry, TelemetryEvent } from "./types.js";

/**
 * Environment and identity inputs that are not part of a run's own facts:
 * whether this is a CI run, whether it is the published build, and the identity
 * the event is attributed to. In production `recordRun` derives these from the
 * live process; the telemetry seed script supplies synthetic values. Keeping
 * them as explicit inputs is what lets both callers produce identically-shaped
 * events from the one builder below.
 */
export interface RunEventContext {
  /**
   * True for CI/scheduled runs. Drives the `ci` split, the person-profile flag,
   * and (via the caller) the sentinel identity.
   */
  ci: boolean;

  /**
   * True when the event represents the published `dist/` build rather than a
   * dev/source or seed run.
   */
  production: boolean;

  /**
   * Identity the event is attributed to: an install id (human) or the CI
   * sentinel. The builder does not resolve this; the caller decides.
   */
  distinctId: string;
}

/**
 * The single source of truth for the `openwiki_run` payload. Given a run's
 * facts and its environment context, returns the fully-assembled event exactly
 * as it is sent to PostHog. Pure: it performs no IO and reads no process state,
 * so the production sender and the seed script cannot drift apart. The setup
 * fields (mode, provider, connectors) are present only when the caller supplies
 * them, so they are omitted from update payloads.
 */
export function buildRunEvent(
  details: RunTelemetry,
  context: RunEventContext,
): TelemetryEvent {
  return {
    distinctId: context.distinctId,
    event: TELEMETRY_RUN_EVENT,
    properties: {
      command: details.command,
      outcome: details.outcome,
      ...(details.errorClass ? { error_class: details.errorClass } : {}),
      ...(details.mode ? { mode: details.mode } : {}),
      ...(details.provider ? { provider: details.provider } : {}),
      ...connectorProperties(details.configuredConnectors ?? []),
      // True for the published build, false for dev/source/seed runs; lets real
      // usage be separated from local testing and pre-launch seed data.
      production: context.production,
      // Splits any metric human vs CI; also drives identity via the caller.
      ci: context.ci,
      // Never build a PostHog person: every run is anonymous. Unique-install
      // counts still work off the random install-id `distinctId` (humans get a
      // per-machine UUID, CI collapses to a per-provider sentinel); we forgo
      // only person-profile features like retention. Sent explicitly as `false`
      // so it never depends on the project's person-profile default.
      $process_person_profile: false,
    },
  };
}

/**
 * Records a completed init/update run: the single event OpenWiki emits. Gates
 * on opt-out, resolves identity, builds the event via `buildRunEvent`, captures
 * it, and optionally tees the exact payload to `--telemetry-file`. The setup
 * fields (mode, provider, connectors) are only present on init, so they are
 * omitted when the caller leaves them undefined. Explicitly never throws.
 * (Chat is not recorded.)
 */
export async function recordRun(details: RunTelemetry): Promise<void> {
  if (isTelemetryDisabled()) {
    await writeTelemetryFile(details.telemetryFile, {
      disabled: true,
      sent: false,
    });
    return;
  }

  try {
    const ci = isCiEnvironment();
    const distinctId = ci ? ciSentinelId() : (await getOrCreateInstallId()).id;
    const event = buildRunEvent(details, {
      ci,
      production: isProductionBuild(),
      distinctId,
    });
    const sent = await capture(event);

    await writeTelemetryFile(details.telemetryFile, {
      disabled: false,
      ci,
      host: DEFAULT_POSTHOG_HOST,
      sent,
      event,
    });
  } catch {
    // Intentionally ignored: telemetry must never break a run.
  }
}

/**
 * Turns configured connector ids into boolean event properties, e.g.
 * `["web-search", "notion"]` -> `{ connector_web_search: true, connector_notion: true }`.
 * Only configured connectors appear; absence means "not configured".
 */
function connectorProperties(configured: string[]): Record<string, true> {
  return Object.fromEntries(
    configured.map((id) => [`connector_${id.replace(/-/g, "_")}`, true]),
  );
}

async function writeTelemetryFile(
  filePath: string | undefined,
  record: Record<string, unknown>,
): Promise<void> {
  if (!filePath) {
    return;
  }

  try {
    const resolved = path.resolve(process.cwd(), filePath);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `OpenWiki: could not write telemetry file "${filePath}": ${message}`,
    );
  }
}
