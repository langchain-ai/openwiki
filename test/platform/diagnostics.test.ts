import { afterEach, describe, expect, test, vi } from "vitest";
import {
  isAuthError,
  sanitizeDiagnosticText,
} from "../../src/platform/diagnostics.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Azure identity diagnostic redaction", () => {
  test.each(["AZURE_CLIENT_SECRET", "AZURE_CLIENT_CERTIFICATE_PASSWORD"])(
    "redacts the exact value of %s",
    (key) => {
      const secret = `fixture-${key.toLowerCase()}-value`;
      vi.stubEnv(key, secret);

      const result = sanitizeDiagnosticText(`credential failed: ${secret}`);

      expect(result).not.toContain(secret);
      expect(result).toContain(`[REDACTED:${key}]`);
    },
  );
});

describe("isAuthError", () => {
  test("classifies 401/403 status codes (number or string) as auth errors", () => {
    expect(isAuthError({ statusCode: 401 }, "boom")).toBe(true);
    expect(isAuthError({ statusCode: 403 }, "boom")).toBe(true);
    expect(isAuthError({ status: "401" }, "boom")).toBe(true);
    expect(isAuthError({ status: "403" }, "boom")).toBe(true);
  });

  test("classifies auth-shaped messages regardless of status", () => {
    for (const message of [
      "Incorrect API key provided",
      "invalid api key",
      "401 Unauthorized",
      "authentication failed",
      "permission denied",
      "you are not authorized",
      // 403/forbidden and a bare status code in the message (the provider does
      // not always expose statusCode on the error object).
      '403 "Forbidden"',
      "Forbidden",
      "request failed with status 401",
    ]) {
      expect(isAuthError(undefined, message)).toBe(true);
    }
  });

  test("does not flag unrelated failures", () => {
    expect(isAuthError({ statusCode: 500 }, "internal server error")).toBe(
      false,
    );
    expect(isAuthError(new Error("timeout"), "timeout")).toBe(false);
    expect(isAuthError(undefined, "rate limit exceeded")).toBe(false);
    expect(isAuthError(undefined, "404 not found")).toBe(false);
  });

  test("matches the message case-insensitively", () => {
    expect(isAuthError(undefined, "UNAUTHORIZED")).toBe(true);
    expect(isAuthError(undefined, "Invalid API Key")).toBe(true);
  });
});
