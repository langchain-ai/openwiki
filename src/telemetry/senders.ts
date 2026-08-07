import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { capture } from "./client.js";
import { DEFAULT_POSTHOG_HOST, TELEMETRY_RUN_EVENT } from "./config.js";
import {
  buildChannel,
  ciSentinelId,
  isCiEnvironment,
  isProductionBuild,
  isTelemetryDisabled,
} from "./gates.js";
import { getOrCreateInstallId } from "./install-id.js";
import type { BuildChannel, RunTelemetry, TelemetryEvent } from "./types.js";

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
   * The distribution channel this build was produced for (see
   * {@link BuildChannel}). Baked at build time, so the caller resolves it (via
   * `buildChannel()`) and the builder stays pure. Stamped on every event so
   * fork-originated telemetry can be separated from the official-release signal.
   */
  buildChannel: BuildChannel;

  /**
   * Identity the event is attributed to: an install id (human) or the CI
   * sentinel. The builder does not resolve this; the caller decides.
   */
  distinctId: string;

  /**
   * OpenWiki version from the bundled `package.json` (e.g. "0.2.3"). Stamped on
   * every event so adoption and per-version breakage are readable, and so the
   * dashboard can scope metrics to a known version. Resolved by the caller from
   * disk; the builder stays pure.
   *
   * @default undefined - the bundled package.json could not be read or had no
   * version; the field is omitted rather than sent empty.
   */
  appVersion?: string;
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
      // The specific failure within the family and who owns the fix. Detail is an
      // allowlisted word (or, for the residual `agent_error` bucket, the innermost
      // error's allowlisted name), dropped upstream if off-list; owner is derived
      // from (class, detail, stage) so the dashboard can roll up by who must act,
      // including the cross-owner exceptions PostHog cannot derive. Failure-only.
      ...(details.errorDetail ? { error_detail: details.errorDetail } : {}),
      ...(details.errorOwner ? { error_owner: details.errorOwner } : {}),
      // Where in the pipeline the failure was tagged, and the provider's numeric
      // status if one was present. Both failure-only and omitted when absent, so
      // the null bucket reads as "not instrumented / no status" rather than a
      // named value. No provider strings ride with the status.
      ...(details.errorStage ? { error_stage: details.errorStage } : {}),
      ...(details.httpStatus !== undefined
        ? { http_status: details.httpStatus }
        : {}),
      ...(details.mode ? { mode: details.mode } : {}),
      ...(details.provider ? { provider: details.provider } : {}),
      ...connectorProperties(details.configuredConnectors ?? []),
      // True for the published build, false for dev/source/seed runs; lets real
      // usage be separated from local testing and pre-launch seed data.
      production: context.production,
      // Distribution channel baked at build time: "official" only for npm-published
      // upstream builds, "community" for forks/local/dev. Lets the dashboard scope
      // the official-release signal and drop fork-originated telemetry. A closed
      // two-value enum; no free strings.
      build_channel: context.buildChannel,
      // Distribution provenance: the OpenWiki version from the bundled
      // package.json, stamped on every event so adoption and per-version
      // breakage are readable. Omitted when the caller could not resolve it.
      ...(context.appVersion ? { app_version: context.appVersion } : {}),
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
      buildChannel: buildChannel(),
      distinctId,
      appVersion: packageProvenance().appVersion,
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
 * Non-identifying distribution provenance read once from the bundled
 * `package.json`: the OpenWiki version. Static build metadata, so it is resolved
 * lazily and cached for the process lifetime.
 */
interface PackageProvenance {
  /**
   * `version` from the bundled package.json, or undefined when it could not be
   * read.
   */
  appVersion?: string;
}

/**
 * Cached result of {@link packageProvenance}. `undefined` means "not resolved
 * yet"; once resolved it is an object (possibly empty on failure) and never
 * re-read.
 */
let cachedProvenance: PackageProvenance | undefined;

/**
 * Reads the bundled `package.json` for its `version`, walking up from this
 * module's own location to the nearest package.json that declares a `name` (the
 * name gates out unrelated package.json files without itself being emitted). The
 * version is static, non-identifying build metadata; no user repository content
 * is ever touched. Fully failure-safe: any error (missing file, bad JSON, no
 * name) yields an empty object, so provenance is simply omitted from the event
 * rather than breaking the run. Cached for the process lifetime.
 */
function packageProvenance(): PackageProvenance {
  if (cachedProvenance !== undefined) {
    return cachedProvenance;
  }

  cachedProvenance = {};
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    // Walk up a bounded number of levels: dist/ layouts and src/ layouts differ,
    // so the nearest named package.json may be a few directories up. Bounded so a
    // stray package.json high in the tree cannot send us walking to the root.
    for (let depth = 0; depth < 6; depth++) {
      const candidate = path.join(dir, "package.json");
      try {
        const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"));
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof (parsed as { name?: unknown }).name === "string"
        ) {
          const pkg = parsed as { version?: unknown };
          cachedProvenance = {
            appVersion:
              typeof pkg.version === "string" ? pkg.version : undefined,
          };
          break;
        }
      } catch {
        // No readable/valid package.json at this level; keep walking up.
      }

      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  } catch {
    // Intentionally ignored: provenance is best-effort, never fatal.
  }

  return cachedProvenance;
}

/**
 * Turns configured connector ids into boolean event properties, e.g.
 * `["web-search", "notion"]` -> `{ connector_web_search: true, connector_notion: true }`.
 * Only configured connectors appear; absence means "not configured".
 */
function connectorProperties(configured: string[]): Record<string, true> {
  return Object.fromEntries(
    configured.map((id) => [`connector_${id.replace(/-/gu, "_")}`, true]),
  );
}

async function writeTelemetryFile(
  filePath: string | undefined,
  record: Record<string, unknown>,
): Promise<void> {
  if (!filePath) {
    return;
  }

  const resolved = path.resolve(process.cwd(), filePath);
  // Write to an unguessable, owner-only scratch sibling and atomically rename it
  // into place, rather than writing the caller's path directly. `--telemetry-file`
  // may point at a shared directory such as /tmp, where a direct write would
  // follow a pre-planted symlink (clobbering an arbitrary file with our
  // privileges) and inherit umask permissions (leaking run metadata to other
  // local users). The random name defeats pre-creation, `flag: "wx"` refuses to
  // open through an existing symlink, `mode: 0o600` keeps it owner-only, and
  // `rename` replaces the final directory entry itself instead of writing
  // through a symlink at that path.
  const scratch = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${randomBytes(6).toString("hex")}.tmp`,
  );

  try {
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(scratch, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(scratch, resolved);
  } catch (error) {
    // Best-effort cleanup so a failed write never leaves the scratch behind.
    await rm(scratch, { force: true }).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `OpenWiki: could not write telemetry file "${filePath}": ${message}`,
    );
  }
}
