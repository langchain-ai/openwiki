import { describe, expect, test } from "vitest";
import { appendRunLogEvent } from "../../../src/cli/run-log/reducer.ts";
import type { OpenWikiRunEvent } from "../../../src/agent/types.ts";
import type { RunLogItem } from "../../../src/cli/run-log/types.ts";

/**
 * Builds a fresh log-id ref, mirroring the useRef the App threads through.
 */
function idRef(start = 0): { current: number } {
  return { current: start };
}

describe("appendRunLogEvent text handling", () => {
  test("appends a text line and advances the id", () => {
    const ref = idRef();
    const log = appendRunLogEvent([], { type: "text", text: "hello" }, ref);

    expect(log).toEqual([{ id: 0, type: "text", content: "hello" }]);
    expect(ref.current).toBe(1);
  });

  test("drops empty and subgraph text without touching the log", () => {
    const existing: RunLogItem[] = [{ id: 0, type: "text", content: "a" }];

    expect(
      appendRunLogEvent(existing, { type: "text", text: "" }, idRef()),
    ).toBe(existing);
    expect(
      appendRunLogEvent(
        existing,
        { type: "text", source: "subgraph", text: "x" },
        idRef(),
      ),
    ).toBe(existing);
  });

  test("concatenates consecutive assistant text onto the last line", () => {
    const ref = idRef(1);
    const log = appendRunLogEvent(
      [{ id: 0, type: "text", content: "foo" }],
      { type: "text", text: "bar" },
      ref,
    );

    expect(log).toEqual([{ id: 0, type: "text", content: "foobar" }]);
    expect(ref.current).toBe(1);
  });

  test("appends a debug line", () => {
    const log = appendRunLogEvent(
      [],
      { type: "debug", message: "dbg" },
      idRef(),
    );
    expect(log).toEqual([{ id: 0, type: "debug", content: "dbg" }]);
  });

  test("drops intermediate narration when a later tool starts", () => {
    const ref = idRef();
    let log = appendRunLogEvent(
      [],
      { type: "text", text: "Let me inspect the repository." },
      ref,
    );

    log = appendRunLogEvent(
      log,
      {
        type: "tool_start",
        call: "read_file(path=/README.md)",
        id: "read-1",
        input: { path: "/README.md" },
        name: "read_file",
      },
      ref,
    );

    expect(log.some((item) => item.type === "text")).toBe(false);
  });
});

describe("appendRunLogEvent repository progress", () => {
  test("replaces the current lifecycle stage without losing tool activity", () => {
    const ref = idRef();
    let log = appendRunLogEvent(
      [],
      { type: "repository_progress", stage: "planning", resumed: true },
      ref,
    );
    log = appendRunLogEvent(
      log,
      {
        type: "tool_start",
        call: "read_file",
        id: "read-1",
        input: { path: "/README.md" },
        name: "read_file",
      },
      ref,
    );
    log = appendRunLogEvent(
      log,
      {
        type: "repository_progress",
        stage: "generating",
        page: "/openwiki/quickstart.md",
        pageIndex: 1,
        pageCount: 3,
      },
      ref,
    );

    expect(log.filter((item) => item.type === "repository_progress")).toEqual([
      expect.objectContaining({
        id: 0,
        stage: "generating",
        page: "/openwiki/quickstart.md",
        pageIndex: 1,
        pageCount: 3,
      }),
    ]);
    expect(log).toContainEqual(
      expect.objectContaining({ type: "tool", actionCount: 1 }),
    );
  });

  test("retains planning, replanning, finalizing, and no-op states", () => {
    const ref = idRef();
    let log: RunLogItem[] = [];
    for (const stage of [
      "planning",
      "replanning",
      "finalizing",
      "noop",
    ] as const) {
      log = appendRunLogEvent(log, { type: "repository_progress", stage }, ref);
      expect(log).toContainEqual(expect.objectContaining({ stage }));
    }
    expect(ref.current).toBe(1);
  });
});

describe("appendRunLogEvent tool grouping", () => {
  const start = (id: string, name = "grep"): OpenWikiRunEvent => ({
    type: "tool_start",
    call: `${name}()`,
    id,
    input: {},
    name,
  });

  test("starts a running tool line for the first tool call", () => {
    const log = appendRunLogEvent([], start("t1"), idRef());

    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      type: "tool",
      status: "running",
      actionCount: 1,
      activeToolCallIds: ["t1"],
    });
  });

  test("merges a second tool call into the same group", () => {
    const ref = idRef();
    let log = appendRunLogEvent([], start("t1"), ref);
    log = appendRunLogEvent(log, start("t2"), ref);

    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      status: "running",
      actionCount: 2,
      activeToolCallIds: ["t1", "t2"],
    });
  });

  test("settles a single tool call to done on a finished end", () => {
    const ref = idRef();
    let log = appendRunLogEvent([], start("t1"), ref);
    log = appendRunLogEvent(
      log,
      { type: "tool_end", id: "t1", name: "grep", status: "finished" },
      ref,
    );

    expect(log[0]).toMatchObject({
      status: "done",
      errorCount: 0,
      activeToolCallIds: [],
    });
  });

  test("marks the group errored and counts the failure", () => {
    const ref = idRef();
    let log = appendRunLogEvent([], start("t1"), ref);
    log = appendRunLogEvent(
      log,
      { type: "tool_end", id: "t1", name: "grep", status: "error" },
      ref,
    );

    expect(log[0]).toMatchObject({ status: "error", errorCount: 1 });
  });

  test("leaves the log unchanged for an unknown tool_end id", () => {
    const ref = idRef();
    const log = appendRunLogEvent([], start("t1"), ref);
    const after = appendRunLogEvent(
      log,
      {
        type: "tool_end",
        id: "does-not-exist",
        name: "grep",
        status: "finished",
      },
      ref,
    );

    expect(after).toBe(log);
  });

  test("stays running until every call in the group has ended", () => {
    const ref = idRef();
    let log = appendRunLogEvent([], start("t1"), ref);
    log = appendRunLogEvent(log, start("t2"), ref);

    log = appendRunLogEvent(
      log,
      { type: "tool_end", id: "t1", name: "grep", status: "finished" },
      ref,
    );
    expect(log[0]).toMatchObject({
      status: "running",
      activeToolCallIds: ["t2"],
    });

    log = appendRunLogEvent(
      log,
      { type: "tool_end", id: "t2", name: "grep", status: "finished" },
      ref,
    );
    expect(log[0]).toMatchObject({ status: "done", activeToolCallIds: [] });
  });

  test("tracks repository reads and OpenWiki writes without subagent prose", () => {
    const ref = idRef();
    let log = appendRunLogEvent(
      [],
      {
        type: "tool_start",
        call: "read_file(path=/src/agent/index.ts)",
        id: "read-source",
        input: { path: "/src/agent/index.ts" },
        name: "read_file",
      },
      ref,
    );
    log = appendRunLogEvent(
      log,
      {
        type: "tool_start",
        call: "write_file(path=/openwiki/agent/workflow.md)",
        id: "write-wiki",
        input: { path: "/openwiki/agent/workflow.md" },
        name: "write_file",
      },
      ref,
    );

    expect(log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          activityOperation: "read",
          activityPath: "src/agent/index.ts",
          activityScope: "repository",
          activityStatus: "active",
          type: "activity",
        }),
        expect.objectContaining({
          activityOperation: "write",
          activityPath: "openwiki/agent/workflow.md",
          activityScope: "openwiki",
          activityStatus: "active",
          type: "activity",
        }),
      ]),
    );

    log = appendRunLogEvent(
      log,
      {
        type: "tool_end",
        id: "read-source",
        name: "read_file",
        status: "finished",
      },
      ref,
    );

    expect(
      log.find((item) => item.activityPath === "src/agent/index.ts"),
    ).toMatchObject({ activityStatus: "recent", activeToolCallIds: [] });
    expect(log.find((item) => item.type === "tool")?.exploredPaths).toEqual([
      "src/agent/index.ts",
    ]);
  });

  test("records only unique successful repository reads as explored", () => {
    const ref = idRef();
    let log: RunLogItem[] = [];

    for (const [id, activityPath, status] of [
      ["read-1", "/src/agent/index.ts", "finished"],
      ["read-2", "/src/agent/index.ts", "finished"],
      ["read-wiki", "/openwiki/quickstart.md", "finished"],
      ["read-failed", "/src/agent/prompt.ts", "error"],
    ] as const) {
      log = appendRunLogEvent(
        log,
        {
          type: "tool_start",
          call: `read_file(path=${activityPath})`,
          id,
          input: { path: activityPath },
          name: "read_file",
        },
        ref,
      );
      log = appendRunLogEvent(
        log,
        { type: "tool_end", id, name: "read_file", status },
        ref,
      );
    }

    expect(log.find((item) => item.type === "tool")?.exploredPaths).toEqual([
      "src/agent/index.ts",
    ]);
  });

  test("records unique persistent OpenWiki pages after successful writes", () => {
    const ref = idRef();
    let log: RunLogItem[] = [];

    for (const [id, activityPath] of [
      ["write-1", "/openwiki/quickstart.md"],
      ["write-2", "/openwiki/quickstart.md"],
    ]) {
      log = appendRunLogEvent(
        log,
        {
          type: "tool_start",
          call: `write_file(path=${activityPath})`,
          id,
          input: { path: activityPath },
          name: "write_file",
        },
        ref,
      );
      log = appendRunLogEvent(
        log,
        {
          type: "tool_end",
          id,
          name: "write_file",
          status: "finished",
        },
        ref,
      );
    }

    expect(log.find((item) => item.type === "tool")?.writtenPaths).toEqual([
      "openwiki/quickstart.md",
    ]);
  });

  test("does not record failed writes as completed pages", () => {
    const ref = idRef();
    let log = appendRunLogEvent(
      [],
      {
        type: "tool_start",
        call: "write_file(path=/openwiki/quickstart.md)",
        id: "write",
        input: { path: "/openwiki/quickstart.md" },
        name: "write_file",
      },
      ref,
    );

    log = appendRunLogEvent(
      log,
      {
        type: "tool_end",
        id: "write",
        name: "write_file",
        status: "error",
      },
      ref,
    );

    expect(log.find((item) => item.type === "tool")?.writtenPaths).toEqual([]);
  });

  test("counts tasks in the stable aggregate summary", () => {
    const log = appendRunLogEvent(
      [],
      {
        type: "tool_start",
        call: "task(tasks=2)",
        id: "tasks",
        input: { tasks: [{}, {}] },
        name: "task",
      },
      idRef(),
    );

    expect(log[0]).toMatchObject({
      actionCount: 1,
      content: "2 tasks",
      taskCount: 2,
    });
  });

  test("summarizes actions by useful category", () => {
    const ref = idRef();
    const events: OpenWikiRunEvent[] = [
      {
        type: "tool_start",
        call: "read_file()",
        id: "read",
        input: { path: "/src/index.ts" },
        name: "read_file",
      },
      {
        type: "tool_start",
        call: "grep()",
        id: "search",
        input: { path: "/src" },
        name: "grep",
      },
      {
        type: "tool_start",
        call: "write_file()",
        id: "write",
        input: { path: "/openwiki/index.md" },
        name: "write_file",
      },
    ];
    let log: RunLogItem[] = [];

    for (const event of events) {
      log = appendRunLogEvent(log, event, ref);
    }

    expect(log[0]).toMatchObject({
      content: "1 read · 1 search · 1 write",
      readCount: 1,
      searchCount: 1,
      writeCount: 1,
    });
  });

  test("does not guess paths from arbitrary shell commands", () => {
    const log = appendRunLogEvent(
      [],
      {
        type: "tool_start",
        call: 'Execute("cat src/agent/index.ts")',
        id: "shell",
        input: "cat src/agent/index.ts",
        name: "execute",
      },
      idRef(),
    );

    expect(log.some((item) => item.type === "activity")).toBe(false);
  });

  test("keeps a shared path active until every reader finishes", () => {
    const ref = idRef();
    const read = (id: string): OpenWikiRunEvent => ({
      type: "tool_start",
      call: "read_file(path=/src/agent/index.ts)",
      id,
      input: { path: "/src/agent/index.ts" },
      name: "read_file",
    });
    let log = appendRunLogEvent([], read("reader-1"), ref);
    log = appendRunLogEvent(log, read("reader-2"), ref);
    log = appendRunLogEvent(
      log,
      {
        type: "tool_end",
        id: "reader-1",
        name: "read_file",
        status: "finished",
      },
      ref,
    );

    expect(
      log.find((item) => item.activityPath === "src/agent/index.ts"),
    ).toMatchObject({
      activeToolCallIds: ["reader-2"],
      activityStatus: "active",
    });
  });

  test("bounds completed path history", () => {
    const ref = idRef();
    let log: RunLogItem[] = [];

    for (let index = 0; index < 10; index += 1) {
      const id = `read-${index}`;
      log = appendRunLogEvent(
        log,
        {
          type: "tool_start",
          call: `read_file(path=/src/file-${index}.ts)`,
          id,
          input: { path: `/src/file-${index}.ts` },
          name: "read_file",
        },
        ref,
      );
      log = appendRunLogEvent(
        log,
        {
          type: "tool_end",
          id,
          name: "read_file",
          status: "finished",
        },
        ref,
      );
    }

    const activities = log.filter((item) => item.type === "activity");
    expect(activities).toHaveLength(8);
    expect(activities.at(-1)).toMatchObject({
      activityPath: "src/file-9.ts",
    });
  });
});
