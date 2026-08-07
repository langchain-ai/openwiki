import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, test } from "vitest";
import {
  ChatHistory,
  ChatInput,
  SlashMenu,
} from "../../../src/cli/components/chat.tsx";
import type { CompletedRun } from "../../../src/cli/components/types.ts";
import { stripAnsi as plain } from "./ansi.ts";

/** A no-op async handler for ChatInput callbacks. */
async function noopAsync(): Promise<void> {}

describe("ChatHistory", () => {
  test("renders nothing when there are no completed runs", () => {
    const { lastFrame } = render(<ChatHistory runs={[]} />);
    expect(plain(lastFrame())).toBe("");
  });

  test("renders each run's prompt, status line, and log", () => {
    const runs: CompletedRun[] = [
      {
        id: 1,
        command: "init",
        log: [{ content: "Wrote 5 pages.", id: 1, type: "text" }],
        message: "seed the wiki",
        result: { command: "init", model: "opus" },
      },
    ];

    const { lastFrame } = render(<ChatHistory runs={runs} />);
    const frame = plain(lastFrame());

    expect(frame).toContain("seed the wiki");
    expect(frame).toContain("Complete");
    expect(frame).toContain("openwiki init - opus");
    expect(frame).toContain("Wrote 5 pages.");
  });

  test("shows a placeholder when a run captured no output", () => {
    const runs: CompletedRun[] = [
      {
        id: 2,
        command: "update",
        log: [],
        message: null,
        result: { command: "update", model: "sonnet" },
      },
    ];

    const { lastFrame } = render(<ChatHistory runs={runs} />);
    expect(plain(lastFrame())).toContain("No assistant output captured.");
  });
});

describe("SlashMenu", () => {
  test("renders the command menu with a highlighted selection", () => {
    const { lastFrame } = render(
      <SlashMenu
        currentModelId="opus"
        currentProvider="anthropic"
        input="/"
        menuState={{ kind: "commands", selectedIndex: 0 }}
      />,
    );
    const frame = plain(lastFrame());

    expect(frame).toContain("Commands");
    expect(frame).toContain("Use arrows, enter to select, esc to cancel.");
  });

  test("renders the provider menu labeled with providers", () => {
    const { lastFrame } = render(
      <SlashMenu
        currentModelId="opus"
        currentProvider="anthropic"
        input="/provider"
        menuState={{ kind: "provider", selectedIndex: 0 }}
      />,
    );
    const frame = plain(lastFrame());

    expect(frame).toContain("Providers");
  });

  test("renders the model menu labeled for the current provider", () => {
    const { lastFrame } = render(
      <SlashMenu
        currentModelId="opus"
        currentProvider="anthropic"
        input="/model"
        menuState={{ kind: "model", selectedIndex: 0 }}
      />,
    );
    const frame = plain(lastFrame());

    expect(frame).toContain("Models for");
  });
});

describe("ChatInput", () => {
  test("renders the empty-state placeholder and hint line", () => {
    const { lastFrame, unmount } = render(
      <ChatInput
        currentModelId="opus"
        currentProvider="anthropic"
        onClear={() => {}}
        onCommandRun={() => {}}
        onModelSelect={noopAsync}
        onProviderSelect={noopAsync}
        onSubmit={() => {}}
      />,
    );
    const frame = plain(lastFrame());

    expect(frame).toContain("Ask a follow-up...");
    expect(frame).toContain("enter to send");
    unmount();
  });
});
