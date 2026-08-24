import React from "react";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  IngestionSummary,
  RunView,
} from "../../../src/cli/components/run-view.tsx";
import type { OpenWikiIngestionResult } from "../../../src/ingestion/ingestion.ts";
import type { RunLogItem } from "../../../src/cli/run-log/types.ts";
import { stripAnsi as plain } from "./ansi.ts";

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

/** Builds an ingestion result with the given per-source statuses. */
function ingestionResult(): OpenWikiIngestionResult {
  return {
    results: [
      {
        connectorId: "github",
        displayName: "Docs Repo",
        rawFiles: ["a.md", "b.md"],
        sourceInstanceId: "src-1",
        status: "agent-updated",
      },
      {
        connectorId: "github",
        displayName: "Broken Repo",
        rawFiles: [],
        sourceInstanceId: "src-2",
        status: "error",
      },
    ],
  } as OpenWikiIngestionResult;
}

describe("IngestionSummary", () => {
  test("renders one status line per source with raw-file counts", () => {
    const { lastFrame } = render(
      <IngestionSummary result={ingestionResult()} />,
    );
    const frame = plain(lastFrame());

    expect(frame).toContain("Source Runs");
    expect(frame).toContain("Docs Repo");
    expect(frame).toContain("agent-updated; 2 raw file(s)");
    expect(frame).toContain("Broken Repo");
    expect(frame).toContain("error; 0 raw file(s)");
  });
});

describe("RunView", () => {
  test("renders native planning, page position, and finalization progress", () => {
    const states: RunLogItem[][] = [
      [
        {
          id: 1,
          type: "repository_progress",
          stage: "planning",
          resumed: true,
        },
      ],
      [
        {
          id: 1,
          type: "repository_progress",
          stage: "generating",
          page: "/openwiki/architecture.md",
          pageIndex: 2,
          pageCount: 4,
        },
      ],
      [
        {
          id: 1,
          type: "repository_progress",
          stage: "finalizing",
        },
      ],
    ];
    const { lastFrame, rerender, unmount } = render(
      <RunView command="update" log={states[0]} />,
    );
    expect(plain(lastFrame())).toContain("Resuming repository wiki planning");

    rerender(<RunView command="update" log={states[1]} />);
    expect(plain(lastFrame())).toContain(
      "Documenting page 2 of 4 · /openwiki/architecture.md",
    );

    rerender(<RunView command="update" log={states[2]} />);
    expect(plain(lastFrame())).toContain("Finalizing repository wiki");
    unmount();
  });

  test("renders replanning and completed no-op states", () => {
    const replanning: RunLogItem[] = [
      {
        id: 1,
        type: "repository_progress",
        stage: "replanning",
        resumed: true,
      },
    ];
    const active = render(<RunView command="update" log={replanning} />);
    expect(plain(active.lastFrame())).toContain(
      "Repository changed during generation · rebuilding the plan",
    );
    active.unmount();

    const noop: RunLogItem[] = [
      { id: 1, type: "repository_progress", stage: "noop" },
    ];
    const complete = render(
      <RunView command="update" done durationMs={10} log={noop} />,
    );
    expect(plain(complete.lastFrame())).toContain(
      "Repository wiki is already current",
    );
    complete.unmount();
  });

  test("renders a completed init outcome, duration, paths, and useful counts", () => {
    const log: RunLogItem[] = [
      {
        actionCount: 9,
        content: "3 reads · 4 searches · 2 writes",
        id: 1,
        readCount: 3,
        searchCount: 4,
        status: "done",
        type: "tool",
        writeCount: 2,
        writtenPaths: ["openwiki/quickstart.md", "openwiki/cli/usage.md"],
      },
      { content: "Generated 3 pages.", id: 2, type: "text" },
    ];

    const { lastFrame, unmount } = render(
      <RunView
        command="init"
        done
        durationMs={3_200}
        log={log}
        message="document the parser"
        modelId="opus"
      />,
    );
    const frame = plain(lastFrame());

    expect(frame).toContain("Run complete");
    expect(frame).toContain("Generated 2 OpenWiki pages in 3s");
    expect(frame).toContain("✓");
    expect(frame).toContain("openwiki/quickstart.md");
    expect(frame).toContain("openwiki/cli/usage.md");
    expect(frame).toContain("3 reads · 4 searches");
    expect(frame).toMatch(/openwiki\/cli\/usage\.md\n\s*\n\s+3 reads/u);
    expect(frame).not.toContain("2 writes");
    expect(frame).toContain("document the parser");
    expect(frame).toContain("Generated 3 pages.");
    unmount();
  });

  test("renders a no-write update as up to date", () => {
    const log: RunLogItem[] = [
      {
        actionCount: 2,
        content: "1 read · 1 search",
        id: 1,
        readCount: 1,
        searchCount: 1,
        status: "done",
        type: "tool",
      },
    ];

    const { lastFrame, unmount } = render(
      <RunView command="update" done durationMs={780} log={log} />,
    );
    const frame = plain(lastFrame());

    expect(frame).toContain("OpenWiki is up to date in <1s");
    expect(frame).toContain("1 read · 1 search");
    unmount();
  });

  test("shows a stable preparation state while a live run has no activity", () => {
    const { lastFrame, unmount } = render(
      <RunView command="update" log={[]} />,
    );
    const frame = plain(lastFrame());

    expect(frame).toContain("Working");
    expect(frame).toContain("openwiki update");
    expect(frame).toContain("Tracing affected documentation");
    expect(frame).toContain("Preparing the run...");
    expect(frame).toMatch(
      /Tracing affected documentation\n\s{4,}Preparing the run\.\.\./u,
    );
    unmount();
  });

  test("keeps a stable progress indicator while a tool is running", async () => {
    vi.useFakeTimers();
    const log: RunLogItem[] = [
      { content: "read_file", id: 1, type: "tool", status: "running" },
    ];

    const { lastFrame, unmount } = render(
      <RunView command="update" done={false} log={log} />,
    );

    expect(plain(lastFrame())).toContain("read_file");
    expect(plain(lastFrame())).toContain("◐");
    expect(plain(lastFrame())).toMatch(
      /Tracing affected documentation\n\s{4,}read_file/u,
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(plain(lastFrame())).toContain("◓");

    unmount();
  });

  test("renders every explored repository file", () => {
    const log: RunLogItem[] = [
      {
        actionCount: 2,
        activeToolCallIds: ["read", "write"],
        content: "2 actions",
        exploredPaths: [
          "src/agent/index.ts",
          "src/integrations/core/protocol.ts",
        ],
        id: 1,
        status: "running",
        type: "tool",
      },
      {
        activityOperation: "read",
        activityPath: "src/agent/index.ts",
        activityScope: "repository",
        activityStatus: "active",
        id: 2,
        type: "activity",
      },
      {
        activityOperation: "write",
        activityPath: "openwiki/agent/workflow.md",
        activityScope: "openwiki",
        activityStatus: "active",
        id: 3,
        type: "activity",
      },
    ];

    const { lastFrame, unmount } = render(
      <RunView command="update" log={log} />,
    );
    const frame = plain(lastFrame());

    expect(frame).toContain("Exploration map");
    expect(frame).toContain("src/");
    expect(frame).toContain("agent/");
    expect(frame).toContain("index.ts");
    expect(frame).toContain("1–4 of 6");
    expect(frame).toContain("Writing OpenWiki");
    expect(frame).toContain("openwiki/");
    expect(frame).toContain("workflow.md");
    expect(frame).not.toContain("streaming");
    unmount();
  });

  test("keeps the exploration map below recent activity", () => {
    const log: RunLogItem[] = [
      {
        actionCount: 2,
        content: "1 read · 1 search",
        exploredPaths: ["src/agent/index.ts"],
        id: 1,
        status: "running",
        type: "tool",
      },
      {
        activityOperation: "read",
        activityPath: "src/agent/index.ts",
        activityScope: "repository",
        activityStatus: "recent",
        id: 2,
        type: "activity",
      },
    ];

    const { lastFrame, unmount } = render(<RunView command="init" log={log} />);
    const frame = plain(lastFrame());

    expect(frame.indexOf("Recent activity")).toBeLessThan(
      frame.indexOf("Exploration map"),
    );
    expect(frame).toContain("src/");
    expect(frame).toContain("index.ts");
    expect(frame).toContain("read     src/agent/index.ts");
    unmount();
  });

  test("windows a long exploration map and supports manual scrolling", async () => {
    const exploredPaths = Array.from(
      { length: 12 },
      (_, index) => `src/file-${String(index).padStart(2, "0")}.ts`,
    );
    const log: RunLogItem[] = [
      {
        actionCount: 12,
        activeToolCallIds: ["read"],
        content: "12 reads",
        exploredPaths,
        id: 1,
        status: "running",
        type: "tool",
      },
      {
        activityOperation: "read",
        activityPath: "src/file-11.ts",
        activityScope: "repository",
        activityStatus: "active",
        id: 2,
        type: "activity",
      },
    ];

    const utils = render(<RunView command="init" log={log} />);
    await flush();

    const followingFrame = plain(utils.lastFrame());
    expect(followingFrame).toContain("file-11.ts");
    expect(followingFrame).toContain("↑/↓ or j/k scroll");
    expect(followingFrame.split("\n").length).toBeLessThan(24);

    utils.stdin.write("\u001b[A");
    await flush();

    expect(plain(utils.lastFrame())).toContain("file-10.ts");
    expect(plain(utils.lastFrame())).not.toContain("file-11.ts");

    utils.stdin.write("f");
    await flush();

    expect(plain(utils.lastFrame())).toContain("file-11.ts");
    expect(plain(utils.lastFrame())).toContain("following");
    utils.unmount();
  });

  test("shows recent actions with verbs and no unexplained overflow", () => {
    const log: RunLogItem[] = [
      {
        actionCount: 5,
        content: "4 reads · 1 write",
        id: 1,
        status: "done",
        type: "tool",
      },
      ...Array.from({ length: 5 }, (_, index): RunLogItem => ({
        activityOperation: index === 4 ? "write" : "read",
        activityPath:
          index === 4 ? "openwiki/cli/usage.md" : `src/file-${index}.ts`,
        activityScope: index === 4 ? "openwiki" : "repository",
        activityStatus: "recent",
        id: index + 2,
        type: "activity",
      })),
    ];

    const { lastFrame, unmount } = render(
      <RunView command="update" log={log} />,
    );
    const frame = plain(lastFrame());

    expect(frame).toContain("Recent activity");
    expect(frame).toContain("wrote");
    expect(frame).toContain("openwiki/cli/usage.md");
    expect(frame).toContain("read");
    expect(frame).not.toContain("file-0.ts");
    expect(frame).not.toContain("more");
    expect(frame).toMatch(/\n {2}Tracing affected documentation/u);
    expect(frame).toMatch(/\n {2}Recent activity/u);
    expect(frame).toMatch(/Recent activity\n\s{4,}wrote/u);
    unmount();
  });
});
