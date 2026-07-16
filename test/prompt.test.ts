import { describe, expect, test } from "vitest";
import {
  createModeInstructions,
  createSystemPrompt,
  createUserPrompt,
} from "../src/agent/prompt.ts";
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
  test("chat mode answers directly without changing documentation", () => {
    const instructions = createModeInstructions("chat", "repository");

    expect(instructions).toContain("interactive chat turn");
    expect(instructions).toContain("Answer the user's message directly");
    expect(instructions).toMatch(
      /Do not create or update OpenWiki documentation/iu,
    );
  });

  test("init mode describes the selected output location", () => {
    const localInstructions = createModeInstructions("init");
    const repositoryInstructions = createModeInstructions("init", "repository");

    expect(localInstructions).toContain("initial documentation run");
    expect(localInstructions).toContain("/quickstart.md");
    expect(repositoryInstructions).toContain("/openwiki/quickstart.md");
    expect(repositoryInstructions).toContain(
      "Build the documentation structure from scratch",
    );
  });

  test("update mode instructs a surgical refresh", () => {
    const instructions = createModeInstructions("update", "repository");

    expect(instructions).toContain("maintenance update run");
    expect(instructions).toContain("Inspect the existing");
    expect(instructions).toMatch(/surgical/iu);
    expect(instructions).toContain("may be a no-op");
  });

  test("every command produces non-empty, distinct instructions", () => {
    const outputs = COMMANDS.map((command) =>
      createModeInstructions(command, "repository"),
    );

    expect(outputs.every((output) => output.length > 0)).toBe(true);
    expect(new Set(outputs).size).toBe(COMMANDS.length);
  });
});

describe("createSystemPrompt", () => {
  test("scopes local-wiki runs to the local wiki root", () => {
    const prompt = createSystemPrompt("init");

    expect(prompt).toContain("You are OpenWiki");
    expect(prompt).toContain("~/.openwiki/wiki");
    expect(prompt).toContain("Do not modify files outside ~/.openwiki/wiki");
    expect(prompt).toContain("/quickstart.md");
  });

  test("treats repository instructions as read-only control metadata", () => {
    const prompt = createSystemPrompt("init", "repository");

    expect(prompt).toContain("/openwiki/INSTRUCTIONS.md");
    expect(prompt).toContain("shared, user-authored OpenWiki brief");
    expect(prompt).toContain("do not edit it during normal init/update/chat");
    expect(prompt).toContain("/AGENTS.md");
    expect(prompt).toContain("/CLAUDE.md");
  });

  test("includes security and CLI reference rules", () => {
    const prompt = createSystemPrompt("update", "repository");

    expect(prompt).toMatch(/do not read or document secret values/iu);
    expect(prompt).toContain(".env");
    expect(prompt).toContain("--init");
    expect(prompt).toContain("--update");
    expect(prompt).toContain("--print");
    expect(prompt).toContain("--modelId");
    expect(prompt).toContain("--help");
  });

  test("references the correct update metadata path for each output mode", () => {
    expect(createSystemPrompt("update")).toContain("/.last-update.json");
    expect(createSystemPrompt("update", "repository")).toContain(
      "/openwiki/.last-update.json",
    );
  });

  test("appends mode-specific instructions", () => {
    const prompt = createSystemPrompt("init", "repository");

    expect(prompt).toContain("Mode-specific behavior:");
    expect(prompt).toContain(createModeInstructions("init", "repository"));
  });
});

describe("createUserPrompt", () => {
  test("chat returns the user message or a default", () => {
    expect(
      createUserPrompt("chat", context(), "Why is auth in a separate module?"),
    ).toBe("Why is auth in a separate module?");
    expect(createUserPrompt("chat", context())).toBe("Start an OpenWiki chat.");
    expect(createUserPrompt("chat", context(), "   ")).toBe(
      "Start an OpenWiki chat.",
    );
  });

  test("init embeds the repository brief and git summary", () => {
    const prompt = createUserPrompt(
      "init",
      context({
        gitSummary: "M src/auth.ts\nA src/login.ts",
        wikiGoal: "Prioritize architecture and runbooks.",
      }),
      null,
      "repository",
    );

    expect(prompt).toContain(
      "Initialize OpenWiki documentation for this repository",
    );
    expect(prompt).toContain("Prioritize architecture and runbooks.");
    expect(prompt).toContain("M src/auth.ts\nA src/login.ts");
    expect(prompt).toContain("/openwiki/quickstart.md");
  });

  test("local init uses the local wiki path", () => {
    const prompt = createUserPrompt("init", context(), null, "local-wiki");

    expect(prompt).toContain("the local knowledge wiki");
    expect(prompt).toContain("~/.openwiki/wiki");
    expect(prompt).toContain("/quickstart.md");
  });

  test("update embeds metadata and git summary", () => {
    const prompt = createUserPrompt(
      "update",
      context({ lastUpdate: sampleLastUpdate, gitSummary: "recent changes" }),
      null,
      "repository",
    );

    expect(prompt).toContain("Update the existing OpenWiki documentation");
    expect(prompt).toContain("recent changes");
    expect(prompt).toContain(sampleLastUpdate.gitHead as string);
    expect(prompt).toContain(sampleLastUpdate.model);
    expect(prompt).toContain("/openwiki/.last-update.json");
  });

  test("update notes when no previous metadata exists", () => {
    expect(createUserPrompt("update", context(), null, "repository")).toContain(
      "No previous OpenWiki update metadata was found.",
    );
  });

  test("appends only a trimmed non-empty user message", () => {
    const prompt = createUserPrompt(
      "update",
      context(),
      "   focus on the API surface   ",
      "repository",
    );

    expect(prompt).toContain("Additional user instruction:");
    expect(prompt).toContain("focus on the API surface");
    expect(prompt).not.toContain("   focus");
    expect(createUserPrompt("init", context(), "   ")).not.toContain(
      "Additional user instruction:",
    );
  });
});

describe("documentation coverage guidance", () => {
  test("init records deferred domains in the quickstart backlog", () => {
    const prompt = createSystemPrompt("init", "repository");

    expect(prompt).toContain("## Backlog");
    expect(prompt).toContain("area name, source anchor, and a one-line reason");
    expect(prompt).toContain(
      "Do not silently drop a real domain or workflow because of the page budget",
    );
  });

  test("update promotes relevant backlog entries instead of dropping them", () => {
    const prompt = createSystemPrompt("update", "repository");

    expect(prompt).toContain("Read the existing `## Backlog` section");
    expect(prompt).toContain(
      "Promote a backlog entry when recent changes touch that area",
    );
    expect(prompt).toContain("remove the entry from the backlog");
  });

  test("all documentation runs perform a coverage self-check", () => {
    for (const command of ["chat", "init", "update"] as const) {
      expect(createSystemPrompt(command, "repository")).toContain(
        "Before finishing, verify that every identified area is either documented or backlogged",
      );
    }
  });
});
