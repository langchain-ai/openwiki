import React from "react";
import { render } from "ink-testing-library";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  ChatHistory,
  ChatInput,
  SlashMenu,
} from "../../../src/cli/components/chat.tsx";
import type { CompletedRun } from "../../../src/cli/components/types.ts";
import { saveOpenWikiEnv } from "../../../src/config/env.ts";
import { stripAnsi as plain } from "./ansi.ts";

// The secret-input path persists credentials to ~/.openwiki/.env. Mock the writer
// so the tests exercise that path without ever touching the real filesystem; the
// rest of config/env stays real via importOriginal.
vi.mock("../../../src/config/env.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/config/env.ts")>();
  return { ...actual, saveOpenWikiEnv: vi.fn(() => Promise.resolve()) };
});

/** A no-op async handler for ChatInput callbacks. */
async function noopAsync(): Promise<void> {}

/**
 * Let queued microtasks and one macrotask settle so the input handler's async
 * work (submit, credential save, menu selection) completes before assertions.
 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

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
        durationMs: 2_000,
        log: [
          {
            actionCount: 5,
            content: "5 writes",
            id: 1,
            status: "done",
            type: "tool",
            writeCount: 5,
            writtenPaths: Array.from(
              { length: 5 },
              (_, index) => `openwiki/page-${index + 1}.md`,
            ),
          },
          { content: "Wrote 5 pages.", id: 2, type: "text" },
        ],
        message: "seed the wiki",
        reasoningEffort: "max",
        result: { command: "init", model: "opus" },
      },
    ];

    const { lastFrame } = render(<ChatHistory runs={runs} />);
    const frame = plain(lastFrame());

    expect(frame).toContain("seed the wiki");
    expect(frame).toContain("Generated 5 OpenWiki pages in 2s");
    expect(frame).toContain("· opus (effort: max)");
    expect(frame).toContain("Wrote 5 pages.");
  });

  test("shows a placeholder when a run captured no output", () => {
    const runs: CompletedRun[] = [
      {
        id: 2,
        command: "update",
        durationMs: 1_000,
        log: [],
        message: null,
        reasoningEffort: null,
        result: { command: "update", model: "sonnet" },
      },
    ];

    const { lastFrame } = render(<ChatHistory runs={runs} />);
    const frame = plain(lastFrame());
    expect(frame).toContain("No assistant output captured.");
    expect(frame).not.toContain("effort:");
  });

  test("keeps path activity out of completed-run scrollback", () => {
    const runs: CompletedRun[] = [
      {
        id: 3,
        command: "update",
        durationMs: 1_000,
        log: [
          {
            actionCount: 1,
            content: "1 action",
            id: 1,
            status: "done",
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
          { content: "Updated the wiki.", id: 3, type: "text" },
        ],
        message: null,
        reasoningEffort: null,
        result: { command: "update", model: "sonnet" },
      },
    ];

    const frame = plain(render(<ChatHistory runs={runs} />).lastFrame());

    expect(frame).toContain("1 action");
    expect(frame).toContain("Updated the wiki.");
    expect(frame).not.toContain("src/agent/index.ts");
  });
});

describe("SlashMenu", () => {
  test("renders the command menu with a highlighted selection", () => {
    const { lastFrame } = render(
      <SlashMenu
        currentModelId="opus"
        currentProvider="anthropic"
        currentReasoningEffort={null}
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
        currentReasoningEffort={null}
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
        currentReasoningEffort={null}
        input="/model"
        menuState={{ kind: "model", selectedIndex: 0 }}
      />,
    );
    const frame = plain(lastFrame());

    expect(frame).toContain("Models for");
  });

  test("renders only supported reasoning efforts for the selected model", () => {
    const { lastFrame } = render(
      <SlashMenu
        currentModelId="nvidia/nemotron-3-super-120b-a12b"
        currentProvider="nvidia"
        currentReasoningEffort="high"
        input="/effort"
        menuState={{ kind: "effort", selectedIndex: 3 }}
      />,
    );
    const frame = plain(lastFrame());

    expect(frame).toContain("Reasoning effort for NVIDIA NIM");
    expect(frame).toContain("Provider default");
    expect(frame).toContain("none");
    expect(frame).toContain("low");
    expect(frame).toContain("high");
    expect(frame).not.toContain("max");
  });
});

describe("ChatInput", () => {
  test("renders the empty-state placeholder and hint line", () => {
    const { lastFrame, unmount } = render(
      <ChatInput
        currentModelId="opus"
        currentProvider="anthropic"
        currentReasoningEffort={null}
        onClear={() => {}}
        onCommandRun={() => {}}
        onModelSelect={noopAsync}
        onProviderSelect={noopAsync}
        onReasoningEffortSelect={noopAsync}
        onSubmit={() => {}}
      />,
    );
    const frame = plain(lastFrame());

    expect(frame).toContain("Ask a follow-up...");
    expect(frame).toContain("enter to send");
    unmount();
  });
});

describe("ChatInput keyboard interactions", () => {
  /**
   * Renders ChatInput with fresh spy callbacks the tests can assert on.
   *
   * Async because Ink registers the `useInput` stdin listener in an effect that
   * runs after the first render; we flush once here so a keystroke written by
   * the very first `press` is not dropped before that listener attaches.
   */
  async function renderInput(
    overrides: Partial<
      Pick<
        React.ComponentProps<typeof ChatInput>,
        | "currentModelId"
        | "currentProvider"
        | "currentReasoningEffort"
        | "onReasoningEffortSelect"
      >
    > = {},
  ) {
    const onClear = vi.fn();
    const onCommandRun = vi.fn();
    const onModelSelect = vi.fn(() => Promise.resolve());
    const onProviderSelect = vi.fn(() => Promise.resolve());
    const onReasoningEffortSelect =
      overrides.onReasoningEffortSelect ?? vi.fn(() => Promise.resolve());
    const onSubmit = vi.fn();

    const utils = render(
      <ChatInput
        currentModelId={overrides.currentModelId ?? "opus"}
        currentProvider={overrides.currentProvider ?? "anthropic"}
        currentReasoningEffort={overrides.currentReasoningEffort ?? null}
        onClear={onClear}
        onCommandRun={onCommandRun}
        onModelSelect={onModelSelect}
        onProviderSelect={onProviderSelect}
        onReasoningEffortSelect={onReasoningEffortSelect}
        onSubmit={onSubmit}
      />,
    );

    /**
     * Write one keystroke and let it commit before the next. The Ink
     * `useInput` handler closes over the current `input` value, so back-to-back
     * synchronous writes make a later keystroke (e.g. Enter) read a stale value
     * and submit an empty string. Flushing between writes keeps each render in
     * step with the input the test just typed.
     */
    const press = async (data: string): Promise<void> => {
      utils.stdin.write(data);
      await flush();
    };

    // Let the mount effect attach the stdin listener before any keystroke.
    await flush();

    return {
      ...utils,
      press,
      onClear,
      onCommandRun,
      onModelSelect,
      onProviderSelect,
      onReasoningEffortSelect,
      onSubmit,
    };
  }

  beforeEach(() => {
    vi.mocked(saveOpenWikiEnv).mockClear();
  });

  test("echoes typed characters", async () => {
    const { press, lastFrame, unmount } = await renderInput();

    await press("hello");
    expect(plain(lastFrame())).toContain("hello");
    unmount();
  });

  test("backspace deletes the last character", async () => {
    const { press, lastFrame, unmount } = await renderInput();

    await press("abc");
    await press("\u007f");
    const frame = plain(lastFrame());
    expect(frame).toContain("ab");
    expect(frame).not.toContain("abc");
    unmount();
  });

  test("cursor movement keys do not disturb the typed value", async () => {
    const { press, lastFrame, unmount } = await renderInput();

    await press("word");
    await press("\u001b[D"); // left
    await press("\u001b[C"); // right
    await press("\u0001"); // ctrl-a (home)
    await press("\u0005"); // ctrl-e (end)
    expect(plain(lastFrame())).toContain("word");
    unmount();
  });

  test("submits a plain message and clears the input", async () => {
    const { press, onSubmit, unmount } = await renderInput();

    await press("document the parser");
    await press("\r");

    expect(onSubmit).toHaveBeenCalledWith("document the parser");
    unmount();
  });

  test("shows an error when submitting an empty message", async () => {
    const { press, lastFrame, onSubmit, unmount } = await renderInput();

    await press("\r");

    expect(onSubmit).not.toHaveBeenCalled();
    expect(plain(lastFrame())).toContain("Enter a follow-up message.");
    unmount();
  });

  test("opens the command menu when the input starts with a slash", async () => {
    const { press, lastFrame, unmount } = await renderInput();

    await press("/");

    const frame = plain(lastFrame());
    expect(frame).toContain("Commands");
    // Arrow navigation over the menu must not throw.
    await press("\u001b[B");
    await press("\u001b[A");
    expect(plain(lastFrame())).toContain("Commands");
    unmount();
  });

  test("/help surfaces the slash-command help notice", async () => {
    const { press, lastFrame, unmount } = await renderInput();

    await press("/help");
    await press("\r");

    expect(plain(lastFrame())).toContain("Slash commands:");
    unmount();
  });

  test("/clear resets the thread and notifies", async () => {
    const { press, lastFrame, onClear, unmount } = await renderInput();

    await press("/clear");
    await press("\r");

    expect(onClear).toHaveBeenCalledTimes(1);
    expect(plain(lastFrame())).toContain("Started a new chat thread.");
    unmount();
  });

  test("/init runs the init command", async () => {
    const { press, onCommandRun, unmount } = await renderInput();

    await press("/init");
    await press("\r");

    expect(onCommandRun).toHaveBeenCalledWith("init", null);
    unmount();
  });

  test("/exit submits the exit sentinel", async () => {
    const { press, onSubmit, unmount } = await renderInput();

    await press("/exit");
    await press("\r");

    expect(onSubmit).toHaveBeenCalledWith("/exit");
    unmount();
  });

  test("an unknown slash command reports an error", async () => {
    const { press, lastFrame, unmount } = await renderInput();

    await press("/bogus");
    await press("\r");

    expect(plain(lastFrame())).toContain("Unknown command: /bogus");
    unmount();
  });

  test("/model <id> saves a valid model selection", async () => {
    const { press, lastFrame, onModelSelect, unmount } = await renderInput();

    await press("/model opus");
    await press("\r");

    expect(onModelSelect).toHaveBeenCalledWith("opus");
    expect(plain(lastFrame())).toContain("Model switched to opus.");
    unmount();
  });

  test("/effort <value> saves a supported reasoning effort", async () => {
    const { press, lastFrame, onReasoningEffortSelect, unmount } =
      await renderInput({
        currentModelId: "gpt-5.6-terra",
        currentProvider: "openai",
      });

    await press("/effort high");
    await press("\r");

    expect(onReasoningEffortSelect).toHaveBeenCalledWith("high");
    expect(plain(lastFrame())).toContain("Reasoning effort set to high.");
    unmount();
  });

  test("/effort opens a menu with the current value selected", async () => {
    const { press, lastFrame, unmount } = await renderInput({
      currentModelId: "gpt-5.6-terra",
      currentProvider: "openai",
      currentReasoningEffort: "medium",
    });

    await press("/effort");

    const frame = plain(lastFrame());
    expect(frame).toContain("Reasoning effort for OpenAI gpt-5.6-terra");
    expect(frame).toMatch(/medium\s+current/u);
    expect(frame).toContain("max");
    unmount();
  });

  test("/effort reports unsupported models without offering a menu", async () => {
    const { press, lastFrame, unmount } = await renderInput({
      currentModelId: "gpt-5.5",
      currentProvider: "openai",
    });

    await press("/effort");
    expect(plain(lastFrame())).not.toContain("Reasoning effort for OpenAI");
    await press("\r");

    expect(plain(lastFrame())).toContain(
      "Reasoning effort is not supported for OpenAI model gpt-5.5.",
    );
    unmount();
  });

  test("/effort default clears the saved reasoning effort", async () => {
    const { press, onReasoningEffortSelect, unmount } = await renderInput({
      currentModelId: "gpt-5.6-terra",
      currentProvider: "openai",
      currentReasoningEffort: "medium",
    });

    await press("/effort default");
    await press("\r");

    expect(onReasoningEffortSelect).toHaveBeenCalledWith(null);
    unmount();
  });

  test("explains when a shell export shadows a saved reasoning effort", async () => {
    const onReasoningEffortSelect = vi.fn(() =>
      Promise.resolve({ isShadowedByShell: true }),
    );
    const { press, lastFrame, unmount } = await renderInput({
      currentModelId: "gpt-5.6-terra",
      currentProvider: "openai",
      onReasoningEffortSelect,
    });

    await press("/effort low");
    await press("\r");

    expect(onReasoningEffortSelect).toHaveBeenCalledWith("low");
    expect(plain(lastFrame())).toContain(
      "Reasoning effort saved as low, but this session uses the shell value.",
    );
    expect(plain(lastFrame())).toContain("OPENWIKI_REASONING_EFFORT");
    unmount();
  });

  test("/model with an invalid id reports a validation error", async () => {
    const { press, lastFrame, onModelSelect, unmount } = await renderInput();

    await press("/model !!!");
    await press("\r");

    expect(onModelSelect).not.toHaveBeenCalled();
    expect(plain(lastFrame())).toContain("Enter a valid model ID.");
    unmount();
  });

  test("/provider <id> saves a valid provider selection", async () => {
    const { press, onProviderSelect, unmount } = await renderInput();

    await press("/provider openai");
    await press("\r");

    expect(onProviderSelect).toHaveBeenCalledWith("openai");
    unmount();
  });

  test("/api-key enters the masked secret prompt", async () => {
    const { press, lastFrame, unmount } = await renderInput();

    await press("/api-key");
    await press("\r");

    const frame = plain(lastFrame());
    expect(frame).toContain("ANTHROPIC_API_KEY");
    expect(frame).toContain("input is masked");
    expect(frame).toContain("[empty]");
    unmount();
  });

  test("typed secrets are masked and never echoed, then saved by key name", async () => {
    const secret = "sk-ant-TESTSECRET-0001112223334445556";
    const { press, lastFrame, unmount } = await renderInput();

    await press("/api-key");
    await press("\r");

    await press(secret);

    // The raw secret must never appear on screen - only a length summary.
    const maskedFrame = plain(lastFrame());
    expect(maskedFrame).not.toContain(secret);
    expect(maskedFrame).toContain(`[hidden, ${secret.length} chars]`);

    await press("\r");

    expect(saveOpenWikiEnv).toHaveBeenCalledTimes(1);
    const savedArg = vi.mocked(saveOpenWikiEnv).mock.calls[0][0];
    const savedKeys = Object.keys(savedArg);
    // Persisted under the provider's API-key env NAME, with the value carried
    // through verbatim - but the value is never rendered.
    expect(savedKeys).toContain("ANTHROPIC_API_KEY");
    expect(savedArg.ANTHROPIC_API_KEY).toBe(secret);
    expect(plain(lastFrame())).not.toContain(secret);
    unmount();
  });

  test("an empty API key reports that the key is required", async () => {
    const { press, lastFrame, unmount } = await renderInput();

    await press("/api-key");
    await press("\r");

    await press("\r");

    expect(saveOpenWikiEnv).not.toHaveBeenCalled();
    expect(plain(lastFrame())).toContain("ANTHROPIC_API_KEY is required.");
    unmount();
  });

  test("escape cancels the secret prompt without saving", async () => {
    const { press, lastFrame, unmount } = await renderInput();

    await press("/api-key");
    await press("\r");

    await press("partial");
    await press("\u001b"); // escape

    expect(saveOpenWikiEnv).not.toHaveBeenCalled();
    expect(plain(lastFrame())).toContain("Credential update canceled.");
    unmount();
  });

  test("/langsmith-key saved empty clears the LangSmith env values", async () => {
    const { press, unmount } = await renderInput();

    await press("/langsmith-key");
    await press("\r");

    await press("\r");

    expect(saveOpenWikiEnv).toHaveBeenCalledTimes(1);
    const savedArg = vi.mocked(saveOpenWikiEnv).mock.calls[0][0];
    expect(savedArg.LANGSMITH_API_KEY).toBe("");
    expect(savedArg.LANGCHAIN_TRACING_V2).toBe("false");
    unmount();
  });
});
