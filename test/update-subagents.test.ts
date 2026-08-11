import { describe, expect, test } from "vitest";
import { resolveUpdateSubagents } from "../src/agent/update_subagents.ts";

describe("update subagents", () => {
  test("are available only for repository updates", () => {
    expect(
      resolveUpdateSubagents("update", "repository").map(({ name }) => name),
    ).toEqual([
      "update_plan_builder",
      "update_plan_verifier",
      "update_wiki_implementer",
      "update_wiki_verifier",
    ]);

    expect(resolveUpdateSubagents("init", "repository")).toEqual([]);
    expect(resolveUpdateSubagents("chat", "repository")).toEqual([]);
    expect(resolveUpdateSubagents("update", "local-wiki")).toEqual([]);
  });

  test("state distinct mutation boundaries", () => {
    const subagents = resolveUpdateSubagents("update", "repository");
    const planBuilder = subagents.find(
      ({ name }) => name === "update_plan_builder",
    );
    const implementer = subagents.find(
      ({ name }) => name === "update_wiki_implementer",
    );
    const planVerifier = subagents.find(
      ({ name }) => name === "update_plan_verifier",
    );
    const verifier = subagents.find(
      ({ name }) => name === "update_wiki_verifier",
    );

    expect(planBuilder?.systemPrompt).toContain(
      "Write only /openwiki/_plan.md",
    );
    expect(implementer?.systemPrompt).toContain(
      "Never edit /openwiki/_plan.md",
    );
    expect(planVerifier?.systemPrompt).toContain("You are read-only");
    expect(planVerifier?.systemPrompt).toContain(
      "every non-generated changed hunk",
    );
    expect(verifier?.systemPrompt).toContain("You are read-only");
    expect(verifier?.systemPrompt).toContain(
      "Before reading the plan or generated wiki pages",
    );
  });

  test("requires atomic contracts and exact documentation evidence", () => {
    const subagents = resolveUpdateSubagents("update", "repository");
    const planBuilder = subagents.find(
      ({ name }) => name === "update_plan_builder",
    );
    const implementer = subagents.find(
      ({ name }) => name === "update_wiki_implementer",
    );
    const planVerifier = subagents.find(
      ({ name }) => name === "update_plan_verifier",
    );
    const verifier = subagents.find(
      ({ name }) => name === "update_wiki_verifier",
    );

    expect(planBuilder?.systemPrompt).toContain(
      "If two facts can be independently true or false",
    );
    expect(planBuilder?.systemPrompt).toContain("Hunk ID");
    expect(implementer?.systemPrompt).toContain(
      "exact page and heading anchor",
    );
    expect(verifier?.systemPrompt).toContain(
      "Related, adjacent, or implied prose does not count",
    );
    expect(planVerifier?.systemPrompt).toContain("single-pass review");
    expect(verifier?.systemPrompt).toContain("at most one repair wave");
  });
});
