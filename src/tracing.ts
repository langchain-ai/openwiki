import { CallbackHandler } from "@langfuse/langchain";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  LANGFUSE_BASE_URL_ENV_KEY,
  LANGFUSE_PUBLIC_KEY_ENV_KEY,
  LANGFUSE_SECRET_KEY_ENV_KEY,
} from "./constants.js";

export type LangfuseConfig = {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
};

/**
 * Resolves Langfuse tracing configuration from the environment. Returns null
 * when either key is missing or blank, so a blank value acts as an off switch
 * (mirroring how a blank LangSmith key disables LangSmith tracing). The base
 * URL is optional and defaults to Langfuse Cloud; the same code path serves any
 * Langfuse instance.
 */
export function resolveLangfuseConfig(
  env: NodeJS.ProcessEnv = process.env,
): LangfuseConfig | null {
  const publicKey = env[LANGFUSE_PUBLIC_KEY_ENV_KEY]?.trim();
  const secretKey = env[LANGFUSE_SECRET_KEY_ENV_KEY]?.trim();

  if (!publicKey || !secretKey) {
    return null;
  }

  const baseUrl = env[LANGFUSE_BASE_URL_ENV_KEY]?.trim();

  return {
    publicKey,
    secretKey,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

/**
 * Returns whether Langfuse tracing is configured in the environment.
 */
export function isLangfuseConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveLangfuseConfig(env) !== null;
}

type LangfuseTracingState = {
  processor: LangfuseSpanProcessor;
  provider: NodeTracerProvider;
};

let tracingState: LangfuseTracingState | null = null;
let tracingStarted = false;

/**
 * Registers an OpenTelemetry tracer provider with a Langfuse span processor the
 * first time it is called, giving the LangChain callback handler a place to
 * export spans. Idempotent, and a no-op when Langfuse is not configured, so it
 * adds no overhead unless tracing is enabled.
 */
export function startLangfuseTracing(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (tracingStarted) {
    return tracingState !== null;
  }

  tracingStarted = true;

  const config = resolveLangfuseConfig(env);

  if (config === null) {
    return false;
  }

  const processor = new LangfuseSpanProcessor({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  });
  const provider = new NodeTracerProvider({
    spanProcessors: [processor],
  });

  provider.register();
  tracingState = { processor, provider };

  process.once("beforeExit", () => {
    void shutdownLangfuseTracing();
  });

  return true;
}

/**
 * Creates a Langfuse LangChain callback handler when tracing is active, else
 * null. The handler emits spans to the globally registered tracer provider.
 */
export function createLangfuseCallbackHandler(): CallbackHandler | null {
  return tracingState === null ? null : new CallbackHandler();
}

/**
 * Flushes buffered spans. Needed for short-lived runs (for example
 * `openwiki --update --print` in CI) so traces are exported before the process
 * exits. Never throws: a failed export must not fail an OpenWiki run.
 */
export async function flushLangfuseTracing(): Promise<void> {
  if (tracingState === null) {
    return;
  }

  try {
    await tracingState.processor.forceFlush();
  } catch {
    // Ignore export failures; tracing is best-effort.
  }
}

/**
 * Flushes and shuts down the tracer provider during process teardown.
 */
export async function shutdownLangfuseTracing(): Promise<void> {
  if (tracingState === null) {
    return;
  }

  const state = tracingState;
  tracingState = null;

  try {
    await state.provider.shutdown();
  } catch {
    // Ignore shutdown errors during teardown.
  }
}

/**
 * Returns whether Langfuse tracing has been started for this process.
 */
export function isLangfuseTracingActive(): boolean {
  return tracingState !== null;
}
