import type { OpenWikiCommand, OpenWikiRunOptions } from "../agent/types.js";
import type { OpenWikiProvider } from "../config/constants.js";

import { describeErrorForTelemetry } from "./errors.js";
import { recordRunSafe } from "./record-run-safe.js";

/**
 * Mutable run facts that resolve as a run proceeds, enriched in place by
 * `runOpenWikiAgent` and read by {@link withRunTelemetry} once the run settles.
 *
 * This is what lets the single telemetry boundary sit *outside* the agent, wrapping
 * the pre-agent repo setup and connector pulls that today reach no telemetry, while
 * still attributing the provider and a `noop` short-circuit that are only knowable
 * *inside* the agent. The caller creates one, hands it to both the wrapper and the
 * agent, and the agent writes to it as those facts become known.
 */
export interface RunTelemetryContext {
  /**
   * The resolved LLM provider, published the instant provider resolution succeeds so
   * that a failure later in the run still attributes the right provider.
   *
   * @default undefined - resolution never reached the provider (e.g. a pre-agent
   * setup or connector throw, or the very first resolution step threw); the run is
   * recorded with provider "unknown".
   */
  provider?: OpenWikiProvider;

  /**
   * The non-failure outcome the run reached, set by the agent. The wrapper defaults a
   * clean return to "success" and any throw to "failure", so only a `noop`
   * short-circuit needs to be published here.
   *
   * @default undefined - the run returned without short-circuiting; recorded as
   * "success".
   */
  outcome?: "success" | "noop";
}

/**
 * The single telemetry boundary for one run: the sole place an `openwiki_run` event
 * is recorded.
 *
 * It wraps the whole setup -> connectors -> agent sequence a caller performs, so a
 * failure anywhere in that sequence (repo setup, connector pull, agent prologue, or
 * the agent itself) is recorded exactly once, closing the pre-agent coverage holes
 * where a throw previously reached no telemetry. On a clean return it records the
 * outcome the agent published on `ctx` (defaulting to "success"); on a throw it
 * records "failure" with the anonymous diagnostics from
 * {@link describeErrorForTelemetry}, then rethrows so the CLI still owns the failure
 * UX. It never throws from telemetry: `recordRunSafe` swallows its own errors.
 *
 * @param command - Which run lifecycle this is. Only init/update are recorded; chat
 *   is dropped downstream by `recordRunSafe`.
 * @param options - The run options; `recordRunSafe` reads `outputMode` and
 *   `telemetryFile` from them.
 * @param ctx - The mutable context the wrapped `run` enriches (provider, outcome).
 * @param run - The run to perform and record: setup, connectors, and the agent.
 */
export async function withRunTelemetry<T>(
  command: OpenWikiCommand,
  options: OpenWikiRunOptions,
  ctx: RunTelemetryContext,
  run: () => Promise<T>,
): Promise<T> {
  try {
    const result = await run();

    await recordRunSafe(command, options, {
      provider: ctx.provider,
      outcome: ctx.outcome ?? "success",
    });

    return result;
  } catch (error) {
    await recordRunSafe(command, options, {
      provider: ctx.provider,
      outcome: "failure",
      // Class, detail, owner, stage, and status in one spread. Everything rides
      // closed-set enums or bare integers; no error text enters the payload.
      ...describeErrorForTelemetry(error),
    });

    throw error;
  }
}
