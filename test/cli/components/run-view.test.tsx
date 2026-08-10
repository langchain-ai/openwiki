import React from "react";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  IngestionSummary,
  RunLogLine,
  RunView,
} from "../../../src/cli/components/run-view.tsx";
import type { OpenWikiIngestionResult } from "../../../src/ingestion/ingestion.ts";
import type { RunLogItem } from "../../../src/cli/run-log/types.ts";
import { stripAnsi as plain } from "./ansi.ts";

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

describe("RunLogLine", () => {
  test("renders a running tool with its call detail when active", () => {
    const item: RunLogItem = {
      content: "read_file",
      id: 1,
      type: "tool",
      status: "running",
      call: "read_file(path=README.md)",
    };

    const { lastFrame } = render(
      <RunLogLine activeRunningToolId={1} animationFrame={0} item={item} />,
    );
    const frame = plain(lastFrame());

    expect(frame).toContain("read_file");
    expect(frame).toContain("read_file(path=README.md)");
  });

  test("renders an errored tool with the !! marker", () => {
    const item: RunLogItem = {
      content: "write_file failed",
      id: 2,
      type: "tool",
      status: "error",
    };

    const { lastFrame } = render(<RunLogLine item={item} />);
    const frame = plain(lastFrame());

    expect(frame).toContain("!!");
    expect(frame).toContain("write_file failed");
  });

  test("renders a debug line with a dash marker", () => {
    const item: RunLogItem = {
      content: "thinking about the plan",
      id: 3,
      type: "debug",
    };

    const { lastFrame } = render(<RunLogLine item={item} />);
    expect(plain(lastFrame())).toContain("thinking about the plan");
  });

  test("renders assistant text as markdown", () => {
    const item: RunLogItem = {
      content: "**done** with the docs",
      id: 4,
      type: "text",
    };

    const { lastFrame } = render(<RunLogLine item={item} />);
    const frame = plain(lastFrame());
    expect(frame).toContain("done");
    expect(frame).toContain("with the docs");
  });

  test("renders a completed (done) tool with a green marker", () => {
    const item: RunLogItem = {
      content: "read_file",
      id: 5,
      type: "tool",
      status: "done",
    };

    const { lastFrame } = render(<RunLogLine item={item} />);
    const frame = plain(lastFrame());

    expect(frame).toContain("*");
    expect(frame).toContain("read_file");
  });
});

describe("RunView", () => {
  test("renders a completed run header, prompt echo, and log", () => {
    const log: RunLogItem[] = [
      { content: "Generated 3 pages.", id: 1, type: "text" },
    ];

    const { lastFrame, unmount } = render(
      <RunView
        command="init"
        done
        log={log}
        message="document the parser"
        modelId="opus"
      />,
    );
    const frame = plain(lastFrame());

    expect(frame).toContain("Run complete");
    expect(frame).toContain("Complete");
    expect(frame).toContain("openwiki init");
    expect(frame).toContain("document the parser");
    expect(frame).toContain("Generated 3 pages.");
    unmount();
  });

  test("shows a waiting placeholder while a live run has no log yet", () => {
    const { lastFrame, unmount } = render(
      <RunView command="update" log={[]} />,
    );
    const frame = plain(lastFrame());

    expect(frame).toContain("Working");
    expect(frame).toContain("openwiki update");
    expect(frame).toContain("Waiting for model output...");
    unmount();
  });

  test("animates the spinner while a live run has a running tool", () => {
    // A live run (done=false) with a still-running tool starts the animation
    // interval; advancing time exercises the frame tick and the cleanup on
    // unmount clears the interval.
    vi.useFakeTimers();
    const log: RunLogItem[] = [
      { content: "read_file", id: 1, type: "tool", status: "running" },
    ];

    const { lastFrame, unmount } = render(
      <RunView command="update" done={false} log={log} />,
    );

    expect(plain(lastFrame())).toContain("read_file");
    vi.advanceTimersByTime(140);
    expect(plain(lastFrame())).toContain("read_file");

    unmount();
  });
});
