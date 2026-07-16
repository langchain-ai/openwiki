import { describe, expect, test } from "vitest";
import {
  formatToolDebugEvent,
  formatToolNameUsage,
  formatToolUsageSummary,
  incrementToolNameUsage,
  incrementToolUsage,
} from "../src/agent/tool-observability.js";

describe("tool observability", () => {
  test("classifies filesystem, OpenWiki, and agent tools", () => {
    let counts = incrementToolUsage(undefined, "read_file");
    counts = incrementToolUsage(counts, "openwiki_git_log");
    counts = incrementToolUsage(counts, "task");

    expect(counts).toEqual({ agent: 1, filesystem: 1, openwiki: 1 });
    expect(formatToolUsageSummary(counts)).toBe(
      " | 1 filesystem operation | 1 OpenWiki tool | 1 agent tool",
    );
  });

  test("aggregates tool names deterministically", () => {
    let names = incrementToolNameUsage(undefined, "read_file");
    names = incrementToolNameUsage(names, "openwiki_git_log");
    names = incrementToolNameUsage(names, "read_file");

    expect(formatToolNameUsage(names)).toBe("openwiki_git_log, read_file x2");
  });

  test("debug events contain names and status but never inputs", () => {
    const start = formatToolDebugEvent({
      type: "tool_start",
      call: 'read_file({"path":"/secret"})',
      id: "call-1",
      input: { path: "/secret" },
      name: "read_file",
    });
    const end = formatToolDebugEvent({
      type: "tool_end",
      id: "call-1",
      name: "read_file",
      status: "finished",
    });

    expect(start).toBe("tool.start name=read_file id=call-1");
    expect(start).not.toContain("secret");
    expect(end).toBe("tool.end name=read_file id=call-1 status=finished");
  });
});
