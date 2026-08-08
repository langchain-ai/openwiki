import { describe, expect, test } from "vitest";
import { createSystemPrompt } from "../../src/agent/prompt.ts";
import { OPENWIKI_VERSION } from "../../src/version.ts";

describe("createSystemPrompt OKF guidance", () => {
  test("keeps init requirements compact and update preservation explicit", () => {
    const init = createSystemPrompt("init", "repository");
    const update = createSystemPrompt("update", "repository");

    expect(init).toContain("Only type is required by OKF");
    expect(init).toContain(
      "generated: {by: <producer actor>, at: <ISO 8601 datetime>} # optional",
    );
    expect(init).toContain("index.md and log.md are reserved");
    expect(init).not.toContain(
      "Preserve all existing producer-defined front matter fields",
    );
    expect(update).toContain(
      "Preserve all existing producer-defined front matter fields",
    );
    expect(update).toContain(
      "`index.md` and `log.md` are reserved OKF documents",
    );
    expect(init).not.toContain("Required fields are: `title`");
    expect(init).not.toContain(
      "do not add front matter fields outside the formatter above",
    );
  });

  test("targets OKF v0.2 and the generated trust field in every mode", () => {
    const init = createSystemPrompt("init", "repository");
    const update = createSystemPrompt("update", "repository");
    const personalUpdate = createSystemPrompt("update", "local-wiki");

    for (const prompt of [init, update, personalUpdate]) {
      // v0.1's timestamp is superseded by generated (OKF v0.2 §13.1).
      expect(prompt).not.toContain("v0.1");
      expect(prompt).not.toContain("timestamp: <");
      expect(prompt).toContain(`by: openwiki/${OPENWIKI_VERSION}`);
      expect(prompt).not.toContain("{OKF_PRODUCER_ACTOR}");
    }
    expect(init).toContain("valid OKF v0.2 YAML front matter");
    for (const prompt of [update, personalUpdate]) {
      expect(prompt).toContain("Google Knowledge Catalog OKF v0.2 schema");
      expect(prompt).toContain('okf_version: "0.2"');
      expect(prompt).toContain(
        "generated: {by: <producer actor>, at: <ISO 8601 datetime>} # Optional",
      );
    }
  });
});
