import { describe, expect, test } from "vitest";
import { formatSecretInputSummary } from "../../../src/cli/input/secret.ts";

describe("formatSecretInputSummary", () => {
  test("labels an empty secret without a length", () => {
    expect(formatSecretInputSummary("")).toBe("[empty]");
  });

  test("surfaces only the length, never the raw value", () => {
    const summary = formatSecretInputSummary("sk-super-secret");
    expect(summary).toBe("[hidden, 15 chars]");
    expect(summary).not.toContain("secret");
  });
});
