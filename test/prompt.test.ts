import { describe, expect, test } from "vitest";
import { createSystemPrompt, createUserPrompt } from "../src/agent/prompt.ts";

const runContext = {
  lastUpdate: null,
  gitSummary: "No git changes.",
};

describe("OpenWiki prompts", () => {
  test("system prompt uses the configured docs directory", () => {
    const prompt = createSystemPrompt("init", "docs/openwiki");

    expect(prompt).toContain("documentation in the docs/openwiki/ directory");
    expect(prompt).toContain("/docs/openwiki/quickstart.md");
    expect(prompt).toContain("docs/openwiki/.last-update.json");
    expect(prompt).toContain("rm -f 'docs/openwiki/_plan.md'");
    expect(prompt).not.toContain(
      "This repository has documentation located in the /openwiki directory.",
    );
    expect(prompt).not.toContain("rm -f openwiki/_plan.md");
  });

  test("user prompt uses the configured docs directory", () => {
    const prompt = createUserPrompt("update", runContext, null, "docs/wiki");

    expect(prompt).toContain("Inspect docs/wiki/");
    expect(prompt).toContain("docs/wiki/.last-update.json");
    expect(prompt).not.toContain("Inspect openwiki/");
    expect(prompt).not.toContain("openwiki/.last-update.json");
  });
});
