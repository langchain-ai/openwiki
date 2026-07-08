/**
 * OpenTelemetry (OTLP) trace export.
 *
 * OpenWiki's agent runs are traced through LangChain/LangGraph callbacks, which
 * hand runs to the bundled `langsmith` SDK. By default that SDK emits the native
 * LangSmith protocol. When OTel mode is selected, `initializeOTEL` installs a
 * global tracer provider and the SDK translates the same runs into OTLP spans,
 * so they can be shipped to any OpenTelemetry backend (including self-hosted
 * ones) via `OTEL_EXPORTER_OTLP_ENDPOINT`.
 *
 * `langsmith` is a direct dependency here pinned to dedupe with the copy
 * LangChain already resolves (both share the `>=0.5.0 <1.0.0` range):
 * `initializeOTEL` records the provider in a module-level singleton that the
 * tracer's LangSmith client reads, so both must be the same module instance. A
 * mismatched pin would duplicate that module and silently break the wiring. The
 * dynamic import keeps the optional `@opentelemetry/*` peers off the load path
 * unless tracing is actually enabled.
 */

import type { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";

const OTEL_FLUSH_TIMEOUT_MS = 5_000;

export type OpenTelemetryHandle = {
  provider: BasicTracerProvider;
};

/**
 * True when LangSmith is configured to emit OTLP instead of its native protocol.
 * Mirrors the SDK's own precedence: `LANGSMITH_TRACING_MODE` wins over the legacy
 * `OTEL_ENABLED` / `LANGSMITH_OTEL_ENABLED` flags.
 */
export function isOtelTracingMode(): boolean {
  const mode = process.env.LANGSMITH_TRACING_MODE?.trim().toLowerCase();

  if (mode) {
    return mode === "otel";
  }

  return (
    process.env.OTEL_ENABLED === "true" ||
    process.env.LANGSMITH_OTEL_ENABLED === "true"
  );
}

/**
 * Installs the global OTel tracer provider so callback traces export over OTLP.
 * Returns a flush handle, or null when OTel mode is not selected. Throws only if
 * the optional OTel peers are missing; callers treat that as non-fatal.
 */
export async function initOpenTelemetry(): Promise<OpenTelemetryHandle | null> {
  if (!isOtelTracingMode()) {
    return null;
  }

  const { initializeOTEL } = await import("langsmith/experimental/otel/setup");
  const { DEFAULT_LANGSMITH_TRACER_PROVIDER } = initializeOTEL();

  // initializeOTEL widens its return to the OTel API `TracerProvider`; with no
  // custom provider passed it is concretely a `BasicTracerProvider`, which
  // exposes the `forceFlush` used on shutdown.
  return {
    provider: DEFAULT_LANGSMITH_TRACER_PROVIDER as BasicTracerProvider,
  };
}

/**
 * Flushes buffered spans before the process exits. Short-lived runs (e.g. CI)
 * terminate before the batch processor's timer fires, so without an explicit
 * flush the final spans are dropped. Bounded by a timeout so an unreachable OTLP
 * endpoint cannot hang the CLI on exit.
 */
export async function shutdownOpenTelemetry(
  handle: OpenTelemetryHandle | null,
): Promise<void> {
  if (!handle) {
    return;
  }

  const flush = handle.provider.forceFlush();
  // Guard against a rejection arriving after the timeout already won the race.
  flush.catch(() => undefined);

  const timeout = new Promise<void>((resolve) => {
    setTimeout(resolve, OTEL_FLUSH_TIMEOUT_MS).unref();
  });

  await Promise.race([flush, timeout]);
}
