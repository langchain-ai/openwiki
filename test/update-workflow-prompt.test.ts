import { describe, expect, test } from "vitest";
import { createSystemPrompt } from "../src/agent/prompt.ts";

describe("update subagent workflow prompt", () => {
  test("orders discovery, implementation, verification, and repair", () => {
    const prompt = createSystemPrompt("update", "repository");
    const plan = prompt.indexOf("Invoke 'update_plan_builder'");
    const planVerify = prompt.indexOf("Invoke 'update_plan_verifier'", plan);
    const implement = prompt.indexOf(
      "Launch all 'update_wiki_implementer' batches",
    );
    const verify = prompt.indexOf("invoke 'update_wiki_verifier'", implement);
    const repair = prompt.indexOf("Run exactly one repair wave", verify);

    expect(plan).toBeGreaterThan(-1);
    expect(planVerify).toBeGreaterThan(plan);
    expect(implement).toBeGreaterThan(planVerify);
    expect(verify).toBeGreaterThan(implement);
    expect(repair).toBeGreaterThan(verify);
    expect(prompt).toContain("page sets do not overlap");
    expect(prompt).toContain("Never assign the same page to concurrent");
    expect(prompt).toContain("add every NEW item to the plan");
    expect(prompt).toContain("exactly one repair wave");
  });

  test("caps review loops and keeps the plan until every row is done", () => {
    const prompt = createSystemPrompt("update", "repository");

    expect(prompt).toContain("Do not invoke 'update_plan_verifier' again");
    expect(prompt).toContain("Do not invoke 'update_wiki_verifier' again");
    expect(prompt).toContain(
      "Delete '/openwiki/_plan.md' only after every row is done",
    );
    expect(prompt).toContain(
      "Do not start another plan-verifier or wiki-verifier loop",
    );
  });
});
