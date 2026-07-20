import { describe, expect, test } from "vitest";
import { createSystemPrompt } from "../src/agent/prompt.ts";

describe("createSystemPrompt OKF guidance", () => {
  test("describes Google OKF v0.1 frontmatter and preservation rules", () => {
    const prompt = createSystemPrompt("init", "repository");

    expect(prompt).toContain("Only `type` is required");
    expect(prompt).toContain("`timestamp` is an optional ISO 8601 datetime");
    expect(prompt).toContain(
      "Preserve all existing producer-defined front matter fields",
    );
    expect(prompt).toContain(
      "`index.md` and `log.md` are reserved OKF documents",
    );
    expect(prompt).not.toContain("Required fields are: `title`");
    expect(prompt).not.toContain(
      "do not add front matter fields outside the formatter above",
    );
  });
});
