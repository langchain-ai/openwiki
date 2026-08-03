import { describe, expect, test } from "vitest";
import { resolveWikiQaSubagents } from "../src/agent/wiki_qa_subagents.ts";

describe("wiki Q/A subagents", () => {
  test("are available only for repository init", () => {
    expect(resolveWikiQaSubagents("init", "repository")).toHaveLength(2);
    expect(resolveWikiQaSubagents("update", "repository")).toEqual([]);
    expect(resolveWikiQaSubagents("chat", "repository")).toEqual([]);
    expect(resolveWikiQaSubagents("init", "local-wiki")).toEqual([]);
  });

  test("define read-only finder and verifier prompts", () => {
    const [finder, verifier] = resolveWikiQaSubagents("init", "repository");

    expect(finder.name).toBe("wiki_question_finder");
    expect(finder.systemPrompt.match(/\[Q-0[123]\]:/gu)).toHaveLength(3);
    expect(finder.systemPrompt.match(/Acceptance criteria:/gu)).toHaveLength(4);
    expect(finder.systemPrompt.match(/Source evidence:/gu)).toHaveLength(4);
    expect(finder.systemPrompt).toContain(
      "Return at most 10 questions",
    );
    expect(finder.systemPrompt).toContain("target 8 for a large repository");
    expect(verifier.name).toBe("wiki_answer_verifier");
    expect(verifier.description).toContain("batch of up to three");
    expect(verifier.systemPrompt).toContain("batch of one to three");
    expect(verifier.systemPrompt).toContain('<result id="Q-01"');
    expect(verifier.systemPrompt).toContain("Do not restate answers, criteria");
    expect(verifier.systemPrompt).not.toContain("<answer>");
    expect(verifier.systemPrompt).not.toContain("<criteria>");
    expect(finder.permissions).toEqual([
      { operations: ["write"], paths: ["/**"], mode: "deny" },
    ]);
    expect(verifier.permissions).toEqual(finder.permissions);
  });
});
