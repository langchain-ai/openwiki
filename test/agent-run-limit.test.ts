import { describe, expect, test } from "vitest";
import {
  createAgentRunConfig,
  createIterationLimitPrompt,
} from "../src/agent/index.ts";

describe("createAgentRunConfig", () => {
  test("leaves the dependency default in place when no limit is requested", () => {
    expect(createAgentRunConfig("thread-1", null)).toEqual({
      configurable: { thread_id: "thread-1" },
      version: "v3",
    });
  });

  test("sets the recursion limit outside configurable when requested", () => {
    expect(createAgentRunConfig("thread-1", 12)).toEqual({
      configurable: { thread_id: "thread-1" },
      recursionLimit: 12,
      version: "v3",
    });
  });

  test("asks the agent to wrap up before a configured limit is exhausted", () => {
    expect(createIterationLimitPrompt(5)).toBe("");
    expect(createIterationLimitPrompt(4)).toContain(
      "Stop exploring or delegating new work.",
    );
    expect(createIterationLimitPrompt(1)).toContain("Only 1 agent graph step");
  });
});
