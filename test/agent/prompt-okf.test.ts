import { describe, expect, test } from "vitest";
import { createSystemPrompt } from "../../src/agent/prompt.ts";

describe("createSystemPrompt OKF guidance", () => {
  test("keeps init requirements compact and update preservation explicit", () => {
    const init = createSystemPrompt("init", "repository");
    const update = createSystemPrompt("update", "repository");

    expect(init).toContain("Only `type` is required by OKF");
    // init moved to OKF v0.2 with the merge: `generated` is code-owned and the
    // legacy `timestamp` is superseded, so init forbids writing either instead
    // of documenting a field the formatter now owns. update still spells out
    // the full provenance contract.
    expect(init).toContain("Never write `generated`");
    expect(init).not.toContain("timestamp: <Optional ISO 8601 datetime>");
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

  test("targets OKF v0.2 and cedes the generated field to code in every mode", () => {
    const init = createSystemPrompt("init", "repository");
    const update = createSystemPrompt("update", "repository");
    const personalUpdate = createSystemPrompt("update", "local-wiki");

    for (const prompt of [init, update, personalUpdate]) {
      // v0.1's timestamp is superseded by generated (OKF v0.2 §13.1).
      expect(prompt).not.toContain("v0.1");
      expect(prompt).not.toContain("timestamp: <");
      // `generated` is code-owned: the model is never handed the producer actor
      // nor told to author the field, so no `generated: {by: ...}` template and
      // no resolved `openwiki/<version>` actor string leaks into the prompt.
      expect(prompt).not.toContain("generated: {by:");
      expect(prompt).not.toContain("by: openwiki/");
      expect(prompt).not.toContain("{OKF_PRODUCER_ACTOR}");
      expect(prompt).toContain(
        "OpenWiki stamps generated provenance (last body change) deterministically",
      );
    }
    expect(init).toContain("valid OKF v0.2 YAML front matter");
    for (const prompt of [update, personalUpdate]) {
      expect(prompt).toContain("Google Knowledge Catalog OKF v0.2 schema");
      expect(prompt).toContain('okf_version: "0.2"');
      // The model is told OpenWiki owns the field and not to write it itself.
      expect(prompt).toContain(
        "Do not author, edit, or remove `generated` or `timestamp` yourself",
      );
    }
  });
});
