import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, test, vi } from "vitest";
import { WikiWorkspaceManager } from "../../../src/cli/components/wiki-workspace-manager.tsx";
import { stripAnsi } from "./ansi.ts";
import type { DiscoveredRepository } from "../../../src/linking/wiki-workspaces.ts";

/**
 * Lets Ink attach or process one input listener.
 *
 * @returns Promise settled on the next event-loop turn.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Sends one or more down-arrow key presses to a rendered manager.
 *
 * @param write - Ink stdin writer.
 * @param count - Number of rows to move.
 */
async function moveDown(
  write: (value: string) => void,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    write("\u001b[B");
    await flush();
  }
}

/**
 * Sends individual Backspace key presses to a rendered manager.
 *
 * @param write - Ink stdin writer.
 * @param count - Number of characters to remove.
 */
async function backspace(
  write: (value: string) => void,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    write("\u007f");
    await flush();
  }
}

/**
 * Creates a deterministic streaming repository finder for component tests.
 *
 * @param repositories - Repository rows yielded in order.
 * @returns Finder factory accepted by the workspace manager.
 */
function repositoryFinder(
  ...repositories: readonly DiscoveredRepository[]
): (
  finderPath: string,
  signal: AbortSignal,
) => AsyncIterable<DiscoveredRepository> {
  /**
   * Yields the supplied repository fixtures without filesystem access.
   */
  async function* findRepositories(
    finderPath: string,
    signal: AbortSignal,
  ): AsyncGenerator<DiscoveredRepository> {
    await Promise.resolve();
    if (!finderPath) return;
    for (const repository of repositories) {
      if (signal.aborted) return;
      yield repository;
    }
  }

  return findRepositories;
}

describe("WikiWorkspaceManager", () => {
  test("creates, names, selects, and finishes one workspace", async () => {
    const onSubmit = vi.fn();
    const view = render(
      <WikiWorkspaceManager
        initialWorkspaces={[]}
        finderRoot="/workspace"
        findRepositories={repositoryFinder(
          {
            root: "/workspace/control",
            name: "control",
            path: "control",
            hasOpenWiki: true,
          },
          {
            root: "/workspace/data",
            name: "data",
            path: "data",
            hasOpenWiki: true,
          },
          {
            root: "/workspace/infra",
            name: "infra",
            path: "infra",
            hasOpenWiki: true,
          },
        )}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    await flush();

    view.stdin.write("\r");
    await flush();
    view.stdin.write("Payments");
    await flush();
    view.stdin.write("\r");
    await flush();
    view.stdin.write(" ");
    await flush();
    await moveDown(view.stdin.write, 1);
    view.stdin.write(" ");
    await flush();
    await moveDown(view.stdin.write, 2);
    view.stdin.write("\r");
    await flush();
    await moveDown(view.stdin.write, 3);
    view.stdin.write("\r");
    await flush();
    await moveDown(view.stdin.write, 2);
    view.stdin.write("\r");
    await flush();

    expect(onSubmit).toHaveBeenCalledWith([
      {
        name: "Payments",
        roots: ["/workspace/control", "/workspace/data"],
      },
    ]);
    view.unmount();
  });

  test("shows clean actions without a plus-prefixed create label", async () => {
    const view = render(
      <WikiWorkspaceManager
        initialWorkspaces={[
          {
            id: "payments",
            name: "Payments",
            roots: ["/workspace/control", "/workspace/data"],
          },
        ]}
        finderRoot="/workspace"
        findRepositories={repositoryFinder()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await flush();

    const frame = stripAnsi(view.lastFrame());
    expect(frame).toContain("Payments 2 wikis");
    expect(frame).toContain("Create workspace");
    expect(frame).not.toContain("+ Create workspace");

    view.stdin.write("\r");
    await flush();
    expect(stripAnsi(view.lastFrame())).toContain("Edit wikis");
    expect(stripAnsi(view.lastFrame())).toContain("Rename");
    expect(stripAnsi(view.lastFrame())).toContain("Delete");
    view.unmount();
  });

  test("pins selections while filtering and prevents unavailable selection", async () => {
    const view = render(
      <WikiWorkspaceManager
        initialWorkspaces={[
          {
            id: "payments",
            name: "Payments",
            roots: ["/workspace/control", "/workspace/data"],
          },
        ]}
        finderRoot="/workspace"
        findRepositories={repositoryFinder(
          {
            root: "/workspace/openwiki",
            name: "openwiki",
            path: "openwiki",
            hasOpenWiki: true,
          },
          {
            root: "/workspace/ordinary",
            name: "ordinary",
            path: "ordinary",
            hasOpenWiki: false,
          },
        )}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await flush();
    await flush();

    view.stdin.write("\r");
    await flush();
    view.stdin.write("\r");
    await flush();

    const unfiltered = stripAnsi(view.lastFrame());
    expect(unfiltered.split("● /workspace/control")).toHaveLength(3);
    expect(unfiltered.split("● /workspace/data")).toHaveLength(3);
    expect(unfiltered).toContain("○ /workspace/openwiki");

    view.stdin.write("/ordinary");
    await flush();

    const filtered = stripAnsi(view.lastFrame());
    expect(filtered).toContain("Selected repositories");
    expect(filtered).toContain("● /workspace/control");
    expect(filtered).toContain("● /workspace/data");
    expect(filtered).toContain("ordinary");
    expect(filtered).not.toContain("openwiki");

    view.stdin.write(" ");
    await flush();
    expect(stripAnsi(view.lastFrame())).toContain(
      "This repository does not contain OpenWiki documentation.",
    );
    expect(stripAnsi(view.lastFrame())).not.toContain("● /workspace/ordinary");
    view.unmount();
  });

  test("extends the finder root with a path prefix", async () => {
    const view = render(
      <WikiWorkspaceManager
        initialWorkspaces={[
          {
            id: "payments",
            name: "Payments",
            roots: ["/workspace/control", "/workspace/data"],
          },
        ]}
        finderRoot="/workspace"
        findRepositories={repositoryFinder(
          {
            root: "/workspace/docs",
            name: "docs",
            path: "docs",
            hasOpenWiki: true,
          },
          {
            root: "/workspace/openwiki-swebench-pilot/django",
            name: "django",
            path: "openwiki-swebench-pilot/django",
            hasOpenWiki: false,
          },
          {
            root: "/workspace/deepagents",
            name: "deepagents",
            path: "deepagents",
            hasOpenWiki: true,
          },
        )}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await flush();
    await flush();

    view.stdin.write("\r");
    await flush();
    view.stdin.write("\r");
    await flush();
    view.stdin.write("/docs");
    await flush();

    const docsPath = stripAnsi(view.lastFrame());
    expect(docsPath).toContain("Path: /workspace/docs_");
    expect(docsPath).toContain("○ /workspace/docs");
    expect(docsPath).not.toContain("django");
    expect(docsPath).not.toContain("deepagents");

    await backspace(view.stdin.write, 5);
    view.stdin.write("/deep");
    await flush();

    const pathSearch = stripAnsi(view.lastFrame());
    expect(pathSearch).toContain("Path: /workspace/deep_");
    expect(pathSearch).toContain("○ /workspace/deepagents");
    expect(pathSearch).not.toContain("/workspace/docs");

    await backspace(view.stdin.write, 5);
    expect(stripAnsi(view.lastFrame())).toContain("Path: /workspace_");

    await backspace(view.stdin.write, 10);
    view.stdin.write("\u007f");
    await flush();
    expect(stripAnsi(view.lastFrame())).toContain("Path: ~_");
    view.unmount();
  });
});
