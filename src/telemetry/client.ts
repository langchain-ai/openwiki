import { PostHog } from "posthog-node";

import {
  DEFAULT_POSTHOG_HOST,
  DEFAULT_POSTHOG_KEY,
  FLUSH_TIMEOUT_MS,
} from "./config.js";
import type { TelemetryEvent } from "./types.js";

/**
 * Sends one event with all minimal-collection flags set, awaiting the send
 * itself. Returns whether it actually sent (false when no key is configured).
 *
 * The send is `captureImmediate`, whose returned promise IS the single HTTP
 * request, awaited here (bounded by a timeout because the CLI is short-lived).
 * This is deliberately not the queued `capture()` + flush-on-`shutdown()` path:
 * that defers the send into a batch and can resolve `shutdown()` without the
 * event having landed, which silently drops events under load. Since the CLI
 * emits exactly one event per run and then exits, awaiting the immediate send is
 * both the simplest and the most reliable choice.
 */
export async function capture(event: TelemetryEvent): Promise<boolean> {
  if (!DEFAULT_POSTHOG_KEY) {
    return false;
  }

  const client = new PostHog(DEFAULT_POSTHOG_KEY, {
    host: DEFAULT_POSTHOG_HOST,
    flushAt: 1,
    flushInterval: 0,
    // Drop the $is_server envelope property: this is a CLI, not a server.
    isServer: false,
  });

  try {
    await withTimeout(
      client.captureImmediate({
        distinctId: event.distinctId,
        event: event.event,
        // `$process_person_profile: false` is set by the caller so PostHog
        // never builds a person; every run is anonymous. It travels in
        // event.properties.
        properties: event.properties,
        // No server-side geoip enrichment (no $geoip_* location). The raw client
        // IP is dropped by the project's "Discard client IP data" setting, not
        // here: it is added server-side, so no client-side option can strip it.
        disableGeoip: true,
      }),
      FLUSH_TIMEOUT_MS,
    );
  } finally {
    // Release the client's timers/handles so the process can exit promptly.
    await withTimeout(client.shutdown(), FLUSH_TIMEOUT_MS);
  }

  return true;
}

/**
 * Resolves when `promise` settles or `ms` elapses, whichever comes first.
 */
async function withTimeout(
  promise: Promise<unknown>,
  ms: number,
): Promise<void> {
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms).unref();
    }),
  ]);
}
