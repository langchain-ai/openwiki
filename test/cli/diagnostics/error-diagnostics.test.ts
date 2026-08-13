import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  getErrorDiagnostics,
  type ErrorDiagnostic,
} from "../../../src/cli/diagnostics/error-diagnostics.ts";

const DEBUG = "OPENWIKI_DEBUG";

/**
 * Collapses a diagnostics list into a label -> value lookup for assertions.
 */
function toLookup(diagnostics: ErrorDiagnostic[]): Record<string, string> {
  return Object.fromEntries(diagnostics.map((d) => [d.label, d.value]));
}

describe("getErrorDiagnostics", () => {
  let savedDebug: string | undefined;

  beforeEach(() => {
    savedDebug = process.env[DEBUG];
    delete process.env[DEBUG];
  });

  afterEach(() => {
    if (savedDebug === undefined) {
      delete process.env[DEBUG];
    } else {
      process.env[DEBUG] = savedDebug;
    }
  });

  test("returns nothing for a plain Error when debug is off", () => {
    expect(getErrorDiagnostics(new Error("boom"))).toEqual([]);
  });

  test("extracts name, message, and an inline HTTP status in debug mode", () => {
    process.env[DEBUG] = "1";
    const lookup = toLookup(getErrorDiagnostics(new Error("server said 503")));

    expect(lookup.name).toBe("Error");
    expect(lookup.message).toBe("server said 503");
    expect(lookup.httpStatusFromMessage).toBe("503");
  });

  test("extracts status and case-insensitive headers in debug mode", () => {
    process.env[DEBUG] = "1";
    const lookup = toLookup(
      getErrorDiagnostics({
        status: 429,
        headers: { "X-Request-Id": "req_123" },
      }),
    );

    expect(lookup.status).toBe("429");
    expect(lookup["header.x-request-id"]).toBe("req_123");
  });

  test("extracts OpenRouter metadata even when debug is off", () => {
    const lookup = toLookup(
      getErrorDiagnostics({ metadata: { provider_name: "openai" } }),
    );

    expect(lookup["metadata.provider_name"]).toBe("openai");
  });

  test("redacts secret-like keys inside stringified metadata", () => {
    const diagnostics = getErrorDiagnostics({
      metadata: { raw: { token: "supersecret", note: "ok" } },
    });
    const raw = toLookup(diagnostics)["metadata.raw"];

    expect(raw).toContain("[REDACTED]");
    expect(raw).not.toContain("supersecret");
    expect(raw).toContain("ok");
  });

  test("caps previous_errors at five and notes the remainder", () => {
    const lookup = toLookup(
      getErrorDiagnostics({
        metadata: {
          previous_errors: Array.from({ length: 7 }, (_, i) => `err-${i}`),
        },
      }),
    );

    expect(lookup["metadata.previous_errors.0"]).toBe("err-0");
    expect(lookup["metadata.previous_errors.4"]).toBe("err-4");
    expect(lookup["metadata.previous_errors.5"]).toBeUndefined();
    expect(lookup["metadata.previous_errors.more"]).toBe(
      "2 more previous provider errors",
    );
  });

  test("extracts nested response fields under a dotted prefix", () => {
    process.env[DEBUG] = "1";
    const lookup = toLookup(
      getErrorDiagnostics({
        status: 500,
        response: { status: 503, statusText: "Service Unavailable" },
      }),
    );

    expect(lookup.status).toBe("500");
    expect(lookup["response.status"]).toBe("503");
    expect(lookup["response.statusText"]).toBe("Service Unavailable");
  });
});
