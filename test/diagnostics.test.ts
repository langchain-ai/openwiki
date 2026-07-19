import { describe, expect, test } from "vitest";
import { isAuthError } from "../src/diagnostics.ts";

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
