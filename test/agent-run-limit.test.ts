import { describe, expect, test } from "vitest";
import { createAgentRunConfig } from "../src/agent/index.ts";

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
});
