import { describe, expect, test } from "vitest";
import { formatRuntimeRootInstruction } from "../src/agent/index.ts";

describe("formatRuntimeRootInstruction", () => {
  test("points repository runs at the repo-local openwiki directory", () => {
    const instruction = formatRuntimeRootInstruction("repository");

    expect(instruction).toContain("/openwiki");
    expect(instruction).not.toContain("~/.openwiki/wiki");
    expect(instruction).not.toContain("not a repository-local openwiki");
  });

  test("keeps local wiki runs rooted at the personal wiki virtual root", () => {
    const instruction = formatRuntimeRootInstruction("local-wiki");

    expect(instruction).toContain("local wiki directory");
    expect(instruction).toContain("/quickstart.md");
    expect(instruction).toContain("/_plan.md");
  });
});
