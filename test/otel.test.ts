import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isOtelTracingMode } from "../src/otel.ts";

const OTEL_MODE_ENV_KEYS = [
  "LANGSMITH_TRACING_MODE",
  "OTEL_ENABLED",
  "LANGSMITH_OTEL_ENABLED",
] as const;

describe("isOtelTracingMode", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(
      OTEL_MODE_ENV_KEYS.map((key) => [key, process.env[key]]),
    );
    for (const key of OTEL_MODE_ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of OTEL_MODE_ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  test("defaults to false when nothing is set", () => {
    expect(isOtelTracingMode()).toBe(false);
  });

  test("is true when LANGSMITH_TRACING_MODE=otel (case/space insensitive)", () => {
    process.env.LANGSMITH_TRACING_MODE = "  OTel ";
    expect(isOtelTracingMode()).toBe(true);
  });

  test("is false when LANGSMITH_TRACING_MODE selects a non-otel mode", () => {
    process.env.LANGSMITH_TRACING_MODE = "langsmith";
    process.env.LANGSMITH_OTEL_ENABLED = "true";
    expect(isOtelTracingMode()).toBe(false);
  });

  test("falls back to the legacy OTEL_ENABLED flag", () => {
    process.env.OTEL_ENABLED = "true";
    expect(isOtelTracingMode()).toBe(true);
  });

  test("falls back to the legacy LANGSMITH_OTEL_ENABLED flag", () => {
    process.env.LANGSMITH_OTEL_ENABLED = "true";
    expect(isOtelTracingMode()).toBe(true);
  });
});
