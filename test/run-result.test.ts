import { describe, expect, test } from "vitest";
import { getRunExitCode } from "../src/agent/result.ts";

describe("getRunExitCode", () => {
  test("returns success for a clean run result", () => {
    expect(getRunExitCode({ command: "init", model: "test-model" })).toBe(0);
  });

  test("returns failure for a run result with tool errors", () => {
    expect(
      getRunExitCode({
        command: "update",
        hadToolError: true,
        model: "test-model",
      }),
    ).toBe(1);
  });
});
