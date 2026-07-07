import { describe, expect, test } from "vitest";
import {
  createModeInstructions,
  createSystemPrompt,
  createUserPrompt,
} from "../src/agent/prompt.ts";
import { OPEN_WIKI_DIR, UPDATE_METADATA_PATH } from "../src/constants.ts";
import type {
  OpenWikiCommand,
  RunContext,
  UpdateMetadata,
} from "../src/agent/types.ts";

const COMMANDS: OpenWikiCommand[] = ["chat", "init", "update"];

function context(overrides: Partial<RunContext> = {}): RunContext {
  return {
    lastUpdate: null,
    gitSummary: "git summary fixture",
    ...overrides,
  };
}

const sampleLastUpdate: UpdateMetadata = {
  updatedAt: "2026-07-01T00:00:00.000Z",
  command: "update",
  gitHead: "abc1234",
  model: "test-model",
};

describe("createModeInstructions", () => {
  test("chat mode tells the agent to answer directly and not touch docs", () => {
    const instructions = createModeInstructions("chat");

    expect(instructions).toContain("interactive chat turn");
    expect(instructions).toContain("Answer the user's message directly");
    expect(instructions).toMatch(
      /do not create or update OpenWiki documentation/iu,
    );
  });

  test("init mode instructs building docs from scratch", () => {
    const instructions = createModeInstructions("init");

    expect(instructions).toContain("initial documentation run");
    expect(instructions).toContain("quickstart.md");
    expect(instructions).toContain(
      "Build the documentation structure from scratch",
    );
  });

  test("update mode instructs a surgical refresh", () => {
    const instructions = createModeInstructions("update");

    expect(instructions).toContain("maintenance update run");
    expect(instructions).toContain("Inspect the existing");
    expect(instructions).toMatch(/surgical/iu);
    expect(instructions).toContain("may be a no-op");
  });

  test("every command produces non-empty, distinct instructions", () => {
    const outputs = COMMANDS.map(createModeInstructions);

    for (const output of outputs) {
      expect(output.length).toBeGreaterThan(0);
    }

    expect(new Set(outputs).size).toBe(COMMANDS.length);
  });
});

describe("createSystemPrompt", () => {
  test("identifies the agent and scopes writes to the OpenWiki directory", () => {
    const prompt = createSystemPrompt("init");

    expect(prompt).toContain("You are OpenWiki");
    expect(prompt).toContain(OPEN_WIKI_DIR);
    expect(prompt).toMatch(/do not modify source code outside.*openwiki/iu);
    expect(prompt).toContain("/AGENTS.md");
    expect(prompt).toContain("/CLAUDE.md");
  });

  test("embeds the required AGENTS.md/CLAUDE.md reference section verbatim", () => {
    // The prompt specifies an exact section structure that must be written into
    // /AGENTS.md and /CLAUDE.md. Pin the structural anchors so a future edit
    // can't silently drift the section the agent reproduces.
    const prompt = createSystemPrompt("init");

    expect(prompt).toContain("## OpenWiki");
    expect(prompt).toContain("openwiki/quickstart.md");
    expect(prompt).toContain(
      "read the OpenWiki quickstart first, then follow its links",
    );
  });

  test("includes the security/privacy rules", () => {
    const prompt = createSystemPrompt("update");

    expect(prompt).toMatch(/do not read or document secret values/iu);
    expect(prompt).toContain(".env");
  });

  test("includes the CLI reference block for every command", () => {
    const prompt = createSystemPrompt("chat");

    expect(prompt).toContain("--init");
    expect(prompt).toContain("--update");
    expect(prompt).toContain("--print");
    expect(prompt).toContain("--modelId");
    expect(prompt).toContain("--help");
  });

  test("references the update metadata path so the agent records runs", () => {
    for (const command of COMMANDS) {
      expect(createSystemPrompt(command)).toContain(UPDATE_METADATA_PATH);
    }
  });

  test("appends the mode-specific instructions block", () => {
    const prompt = createSystemPrompt("init");

    expect(prompt).toContain("Mode-specific behavior:");
    expect(prompt).toContain(createModeInstructions("init"));
  });
});

describe("createUserPrompt", () => {
  test("chat returns the user message (or a default when absent)", () => {
    expect(
      createUserPrompt("chat", context(), "Why is auth in a separate module?"),
    ).toBe("Why is auth in a separate module?");

    expect(createUserPrompt("chat", context())).toBe("Start an OpenWiki chat.");
    expect(createUserPrompt("chat", context(), "   ")).toBe(
      "Start an OpenWiki chat.",
    );
  });

  test("init builds a prompt that embeds the git summary", () => {
    const prompt = createUserPrompt(
      "init",
      context({ gitSummary: "M src/auth.ts\nA src/login.ts" }),
    );

    expect(prompt).toContain("Initialize OpenWiki documentation");
    expect(prompt).toContain("M src/auth.ts\nA src/login.ts");
    expect(prompt).toContain(`${OPEN_WIKI_DIR}/quickstart.md`);
  });

  test("update builds a prompt that embeds last-update metadata and git summary", () => {
    const prompt = createUserPrompt(
      "update",
      context({ lastUpdate: sampleLastUpdate, gitSummary: "recent changes" }),
    );

    expect(prompt).toContain("Update the existing OpenWiki documentation");
    expect(prompt).toContain("recent changes");
    // The full metadata JSON is rendered so the agent can see the prior gitHead.
    expect(prompt).toContain(sampleLastUpdate.gitHead as string);
    expect(prompt).toContain(sampleLastUpdate.model);
  });

  test("update notes when no previous update metadata exists", () => {
    const prompt = createUserPrompt("update", context({ lastUpdate: null }));

    expect(prompt).toContain("No previous OpenWiki update metadata was found.");
  });

  test("appends a non-empty user message as an additional instruction", () => {
    const prompt = createUserPrompt(
      "update",
      context(),
      "   focus on the API surface   ",
    );

    expect(prompt).toContain("Additional user instruction:");
    expect(prompt).toContain("focus on the API surface");
    // The trimmed message is used, not the surrounding whitespace.
    expect(prompt).not.toContain("   focus");
  });

  test("does not append a user-message section when the message is blank", () => {
    const prompt = createUserPrompt("init", context(), "   ");

    expect(prompt).not.toContain("Additional user instruction:");
  });
});
