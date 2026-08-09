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

  let sent = false;
  try {
    sent = await withTimeout(
      Promise.resolve().then(() =>
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
      ),
      FLUSH_TIMEOUT_MS,
    );
  } catch {
    // Telemetry is best-effort; a synchronous SDK failure is a failed send.
  } finally {
    // Release the client's timers/handles so the process can exit promptly.
    try {
      await withTimeout(
        Promise.resolve().then(() => client.shutdown()),
        FLUSH_TIMEOUT_MS,
      );
    } catch {
      // Shutdown must not change the outcome of a capture that already settled.
    }
  }

  return sent;
}

/**
 * Returns true only when `promise` fulfills before `ms` elapses. Rejections,
 * synchronous failures converted to rejected promises, and timeouts return
 * false; the caller never waits indefinitely for the short-lived CLI.
 */
async function withTimeout(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve(false);
    }, ms);
    timer.unref();

    promise.then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}
