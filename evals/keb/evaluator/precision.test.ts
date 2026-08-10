import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

import type { EvidenceCorpus } from "../core/types.js";
import {
  type PrecisionAssertionInventory,
  runPrecisionPass,
} from "./precision.js";
import {
  PRECISION_EXTRACTION_SYSTEM,
  PRECISION_LEDGER_SYSTEM,
  PRECISION_JUDGMENT_SYSTEM,
} from "./prompts.js";
import type { ArtifactSection } from "./documents.js";

/**
 * Mutable direct-model test control.
 */
interface ModelControl {
  /**
   * Structured responses consumed in call order.
   */
  responses: unknown[];

  /**
   * System prompts observed in call order.
   */
  systemPrompts: string[];

  /**
   * Task prompts observed in call order.
   */
  taskPrompts: string[];
}

/**
 * Create a source-evidence corpus from concise source snippets.
 *
 * @param contents - Source content in stable record order.
 *
 * @returns Checkpoint evidence with deterministic identities.
 */
function evidence(contents: string[]): EvidenceCorpus {
  return {
    checkpointId: "T0",
    records: contents.map((content, index) => ({
      evidenceId: `source-${index.toString().padStart(2, "0")}::0000`,
      sourceRef: `source-${index.toString().padStart(2, "0")}.txt`,
      observedAtCheckpoint: "T0",
      current: true,
      content,
    })),
  };
}

/**
 * Create one stable Markdown artifact section.
 *
 * @param id - Stable section identity.
 * @param content - Section content.
 * @param headingPath - Optional heading hierarchy.
 *
 * @returns Artifact section suitable for precision evaluation.
 */
function section(
  id: string,
  content: string,
  headingPath: string[] = [],
): ArtifactSection {
  return {
    id,
    relativePath: "guide.md",
    headingPath,
    ordinal: 0,
    content,
    searchableText: content,
  };
}

/**
 * Create a queued structured-output model test double.
 *
 * @param control - Mutable response and prompt capture state.
 *
 * @returns Chat-model-shaped test double.
 */
function fakeModel(control: ModelControl): BaseChatModel {
  return {
    withStructuredOutput: () => ({
      invoke: async (messages: Array<{ content: string }>) => {
        control.systemPrompts.push(messages[0].content);
        control.taskPrompts.push(messages[1].content);
        return control.responses.shift();
      },
    }),
  } as unknown as BaseChatModel;
}

/**
 * Create model control with a fixed response queue.
 *
 * @param responses - Structured responses in invocation order.
 *
 * @returns Initialized model control.
 */
function controller(responses: unknown[]): ModelControl {
  return { responses: [...responses], systemPrompts: [], taskPrompts: [] };
}

describe("runPrecisionPass", () => {
  test("enforces the human-reviewed material-claim and truth-judgment boundaries", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("./fixtures/precision-gold.json", import.meta.url),
        "utf8",
      ),
    ) as {
      units: Array<{
        content: string;
        classification:
          | "factual"
          | "mixed"
          | "navigation"
          | "opinion"
          | "instruction"
          | "no-claim";
        assertions: string[];
        rationale: string;
      }>;
      expectedJudgments: Array<{
        assertion: string;
        verdict: "supported" | "unsupported";
        unsupportedReason?: "contradicted" | "not-established";
        evidenceIds: string[];
      }>;
    };
    const control = controller([
      {
        units: fixture.units.map((unit, index) => ({
          unitId: `guide::0000::unit-${String(index).padStart(4, "0")}`,
          classification: unit.classification,
          assertions: unit.assertions,
          rationale: unit.rationale,
        })),
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "supported",
            evidenceIds: ["source-00::0000"],
            rationale:
              "The complete repository inventory contains no test path.",
          },
          {
            assertionId: "assertion-000002",
            verdict: "supported",
            evidenceIds: ["source-01::0000"],
            rationale:
              "Direct arithmetic evaluation of the function body returns 5.",
          },
          {
            assertionId: "assertion-000003",
            verdict: "contradicted",
            evidenceIds: ["source-02::0000"],
            rationale: "The source declares VERSION as 1.0.0, not 2.0.0.",
          },
          {
            assertionId: "assertion-000004",
            verdict: "not-supported",
            evidenceIds: [],
            rationale:
              "The evidence establishes the value but no maintainer process or intent.",
          },
        ],
      },
    ]);
    let inventory: PrecisionAssertionInventory | undefined;

    const evaluations = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T0",
      activeFacts: [],
      sections: [
        section(
          "guide::0000",
          fixture.units.map((unit) => unit.content).join("\n\n"),
        ),
      ],
      evidence: evidence([
        "Complete repository path inventory:\nsrc/calc.ts\nsrc/version.ts\nREADME.md",
        "export function add(a: number, b: number): number { return a + b; }",
        'export const VERSION = "1.0.0";',
      ]),
      onInventory: (value) => {
        inventory = value;
      },
    });

    expect(inventory?.units).toMatchObject(
      fixture.units.map((unit) => ({
        classification: unit.classification,
        assertions: unit.assertions,
      })),
    );
    expect(evaluations).toMatchObject(fixture.expectedJudgments);
    expect(control.taskPrompts[1]).toContain("source-00::0000");
  });

  test("rejects an extraction response that silently drops a text unit", async () => {
    const incomplete = {
      units: [
        {
          unitId: "guide::0000::unit-0000",
          classification: "navigation",
          assertions: [],
          rationale: "Navigation only.",
        },
      ],
    };
    const control = controller([incomplete, incomplete]);

    await expect(
      runPrecisionPass({
        model: fakeModel(control),
        checkpointId: "T0",
        activeFacts: [],
        sections: [
          section("guide::0000", "See the API page.\n\nVERSION is 1.0.0."),
        ],
        evidence: evidence([]),
      }),
    ).rejects.toThrow(/no result for unitId "guide::0000::unit-0001"/u);
  });

  test("extracts a material claim and supports it from source evidence", async () => {
    const control = controller([
      {
        units: [
          {
            unitId: "guide::0000::unit-0000",
            classification: "factual",
            rationale: "Factual test unit.",
            assertions: ["The current version is 1.0.0."],
          },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "unaccounted",
            factVersionIds: [],
            rationale: "The requirement ledger does not address the version.",
          },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "supported",
            evidenceIds: ["source-00::0000"],
            rationale: "The source declares version 1.0.0.",
          },
        ],
      },
    ]);

    const evaluations = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T0",
      sections: [section("guide::0000", "Current release: 1.0.0.")],
      activeFacts: [
        {
          factId: "api",
          factVersionId: "api@T0",
          category: "behavior",
          statement: "The calculator adds numbers.",
        },
      ],
      evidence: evidence(['export const VERSION = "1.0.0";']),
    });

    expect(evaluations).toEqual([
      {
        assertion: "The current version is 1.0.0.",
        location: "guide.md",
        verdict: "supported",
        evidenceIds: ["source-00::0000"],
        rationale: "The source declares version 1.0.0.",
        verificationSource: "source",
      },
    ]);
    expect(control.systemPrompts).toEqual([
      PRECISION_EXTRACTION_SYSTEM,
      PRECISION_LEDGER_SYSTEM,
      PRECISION_JUDGMENT_SYSTEM,
    ]);
  });

  test("accepts a ledger-supported assertion without source verification", async () => {
    const control = controller([
      {
        units: [
          {
            unitId: "guide::0000::unit-0000",
            classification: "factual",
            rationale: "Factual test unit.",
            assertions: ["The current version is 1.0.0."],
          },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "supported",
            factVersionIds: ["version@T0"],
            rationale: "The active requirement specifies version 1.0.0.",
          },
        ],
      },
    ]);

    const evaluations = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T0",
      sections: [section("guide::0000", "Current release: 1.0.0.")],
      activeFacts: [
        {
          factId: "version",
          factVersionId: "version@T0",
          category: "versioning",
          statement: "The current version is 1.0.0.",
        },
      ],
      evidence: evidence([]),
    });

    expect(evaluations).toEqual([
      {
        assertion: "The current version is 1.0.0.",
        location: "guide.md",
        verdict: "supported",
        evidenceIds: ["version@T0"],
        rationale: "The active requirement specifies version 1.0.0.",
        verificationSource: "ledger",
      },
    ]);
    expect(control.systemPrompts).toEqual([
      PRECISION_EXTRACTION_SYSTEM,
      PRECISION_LEDGER_SYSTEM,
    ]);
  });

  test("finalizes a ledger contradiction without source verification", async () => {
    const control = controller([
      {
        units: [
          {
            unitId: "guide::0000::unit-0000",
            classification: "factual",
            rationale: "Factual test unit.",
            assertions: ["The current version is 2.0.0."],
          },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "contradicted",
            factVersionIds: ["version@T0"],
            rationale: "The active requirement specifies version 1.0.0.",
          },
        ],
      },
    ]);

    const evaluations = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T0",
      sections: [section("guide::0000", "Current release: 2.0.0.")],
      activeFacts: [
        {
          factId: "version",
          factVersionId: "version@T0",
          category: "versioning",
          statement: "The current version is 1.0.0.",
        },
      ],
      evidence: evidence([]),
    });

    expect(evaluations[0]).toMatchObject({
      verdict: "unsupported",
      unsupportedReason: "contradicted",
      verificationSource: "ledger",
      evidenceIds: ["version@T0"],
    });
    expect(control.systemPrompts).toEqual([
      PRECISION_EXTRACTION_SYSTEM,
      PRECISION_LEDGER_SYSTEM,
    ]);
  });

  test("marks an irreparable ledger citation indeterminate", async () => {
    const invalidLedgerResult = {
      evaluations: [
        {
          assertionId: "assertion-000001",
          verdict: "supported",
          factVersionIds: ["invented@T0"],
          rationale: "The invented requirement supports it.",
        },
      ],
    };
    const control = controller([
      {
        units: [
          {
            unitId: "guide::0000::unit-0000",
            classification: "factual",
            rationale: "Factual test unit.",
            assertions: ["The current version is 1.0.0."],
          },
        ],
      },
      invalidLedgerResult,
      invalidLedgerResult,
      invalidLedgerResult,
    ]);
    const warnings: string[] = [];

    const evaluations = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T0",
      sections: [section("guide::0000", "Current release: 1.0.0.")],
      activeFacts: [
        {
          factId: "version",
          factVersionId: "version@T0",
          category: "versioning",
          statement: "The current version is 1.0.0.",
        },
      ],
      evidence: evidence([]),
      onWarning: (warning) => warnings.push(warning.pass),
    });

    expect(evaluations[0]).toMatchObject({
      verdict: "indeterminate",
      evidenceIds: [],
    });
    expect(warnings).toEqual(["precision-ledger"]);
  });

  test("keeps unsupported source subtypes distinct", async () => {
    const control = controller([
      {
        units: [
          {
            unitId: "guide::0000::unit-0000",
            classification: "factual",
            rationale: "Factual test unit.",
            assertions: [
              "The current version is 2.0.0.",
              "Addition is constant time.",
            ],
          },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "contradicted",
            evidenceIds: ["source-00::0000"],
            rationale: "The source declares version 1.0.0.",
          },
          {
            assertionId: "assertion-000002",
            verdict: "not-supported",
            evidenceIds: [],
            rationale: "The source gives no complexity guarantee.",
          },
        ],
      },
    ]);

    const evaluations = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T0",
      activeFacts: [],
      sections: [section("guide::0000", "Version and performance.")],
      evidence: evidence(['export const VERSION = "1.0.0";']),
    });

    expect(evaluations.map((evaluation) => evaluation.verdict)).toEqual([
      "unsupported",
      "unsupported",
    ]);
    expect(
      evaluations.map((evaluation) => evaluation.unsupportedReason),
    ).toEqual(["contradicted", "not-established"]);
  });

  test("allows every assertion to cite evidence visible in its shared judgment batch", async () => {
    const source = evidence([
      "alpha one",
      "alpha two",
      "alpha three",
      "alpha four",
      "alpha five",
      "alpha six",
      "alpha seven",
      "alpha eight",
      "zebra evidence",
    ]);
    const control = controller([
      {
        units: [
          {
            unitId: "guide::0000::unit-0000",
            classification: "factual",
            rationale: "Factual test unit.",
            assertions: ["Alpha behavior exists.", "Zebra behavior exists."],
          },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "supported",
            evidenceIds: ["source-08::0000"],
            rationale: "The shared batch evidence establishes the claim.",
          },
          {
            assertionId: "assertion-000002",
            verdict: "supported",
            evidenceIds: ["source-08::0000"],
            rationale: "The zebra evidence establishes the claim.",
          },
        ],
      },
    ]);

    const evaluations = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T0",
      activeFacts: [],
      sections: [section("guide::0000", "Alpha and zebra behavior.")],
      evidence: source,
    });

    expect(evaluations).toHaveLength(2);
    expect(evaluations[0].evidenceIds).toEqual(["source-08::0000"]);

    const judgmentPrompt = control.taskPrompts[1];
    expect(judgmentPrompt.match(/"source-08::0000"/gu)).toHaveLength(3);
  });

  test("exhausts unretrieved evidence before finalizing not established", async () => {
    const source = evidence([
      "alpha",
      "beta",
      "gamma",
      "delta",
      "epsilon",
      "zeta",
      "eta",
      "theta",
      "42",
    ]);
    const control = controller([
      {
        units: [
          {
            unitId: "guide::0000::unit-0000",
            classification: "factual",
            rationale: "Factual test unit.",
            assertions: ["The answer is forty-two."],
          },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "not-supported",
            evidenceIds: [],
            rationale: "The supplied excerpts do not establish the date.",
          },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "supported",
            evidenceIds: ["source-08::0000"],
            rationale: "Fallback evidence establishes the answer.",
          },
        ],
      },
    ]);

    const evaluations = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T0",
      activeFacts: [],
      sections: [section("guide::0000", "The answer is forty-two.")],
      evidence: source,
    });

    expect(evaluations[0].verdict).toBe("supported");
    expect(control.systemPrompts).toHaveLength(3);
  });

  test("persists exclusions before semantic judgment", async () => {
    const control = controller([
      {
        units: [
          {
            unitId: "guide::0000::unit-0000",
            classification: "factual",
            rationale: "Factual test unit.",
            assertions: [
              "The current version is 1.0.0.",
              "The repository contains exactly three tracked files.",
              "Commit 0ee8f29 added subtract.",
            ],
          },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "supported",
            evidenceIds: ["source-00::0000"],
            rationale: "The source establishes the version.",
          },
        ],
      },
    ]);
    let inventory: PrecisionAssertionInventory | undefined;

    await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T0",
      activeFacts: [],
      sections: [
        section("guide::0000", "Repository facts."),
        section("guide::0001", "Navigation.", ["Related pages"]),
      ],
      evidence: evidence(['export const VERSION = "1.0.0";']),
      onInventory: (value) => {
        inventory = value;
      },
    });

    expect(inventory).toMatchObject({
      totalSectionCount: 2,
      extractedSectionCount: 1,
      keptAssertionCount: 1,
    });
    expect(
      inventory?.candidates.map((candidate) => candidate.exclusionReason),
    ).toEqual([
      undefined,
      "repository-archaeology",
      "commit-history-assertion",
    ]);
    expect(inventory?.excludedSections[0].reason).toBe(
      "wiki-navigation-section",
    );
  });

  test("excludes non-domain forms while retaining checkable absence claims", async () => {
    const control = controller([
      {
        units: [
          {
            unitId: "guide::0000::unit-0000",
            classification: "factual",
            rationale: "Factual test unit.",
            assertions: [
              "The calc library reference documents the package API.",
              "The repository was introduced in commit `973be7a calc 1.0.0`.",
              "The entire tracked repository consists of three files.",
              "Per the module docstring in `src/calc.ts`, calc is tiny.",
              "Extension step 1: add a new export to src/calc.ts.",
              "There is no test suite in the repository.",
            ],
          },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "supported",
            evidenceIds: ["source-00::0000"],
            rationale: "The source inventory establishes no test suite.",
          },
        ],
      },
    ]);
    let inventory: PrecisionAssertionInventory | undefined;

    const evaluations = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T0",
      activeFacts: [],
      sections: [section("guide::0000", "Repository reference material.")],
      evidence: evidence(["source truth"]),
      onInventory: (value) => {
        inventory = value;
      },
    });

    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]).toMatchObject({
      assertion: "There is no test suite in the repository.",
      verdict: "supported",
    });
    expect(
      inventory?.candidates.map((candidate) => candidate.exclusionReason),
    ).toEqual([
      "wiki-meta-assertion",
      "commit-history-assertion",
      "repository-archaeology",
      "repository-archaeology",
      "prescriptive-assertion",
      undefined,
    ]);
  });

  test("isolates then marks an irreparable precision citation indeterminate", async () => {
    const invalid = {
      evaluations: [
        {
          assertionId: "assertion-000001",
          verdict: "supported",
          evidenceIds: ["invented::0000"],
          rationale: "Invented citation.",
        },
      ],
    };
    const control = controller([
      {
        units: [
          {
            unitId: "guide::0000::unit-0000",
            classification: "factual",
            assertions: ["A material claim."],
            rationale: "Factual test unit.",
          },
        ],
      },
      invalid,
      invalid,
      invalid,
    ]);
    const warnings: string[] = [];

    const [evaluation] = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T0",
      activeFacts: [],
      sections: [section("guide::0000", "A material claim.")],
      evidence: evidence(["source truth"]),
      onWarning: (warning) => warnings.push(warning.itemId),
    });

    expect(evaluation.verdict).toBe("indeterminate");
    expect(warnings).toEqual(["assertion-000001"]);
  });

  test("preserves valid precision neighbors when one item is indeterminate", async () => {
    const invalidItem = {
      evaluations: [
        {
          assertionId: "assertion-000002",
          verdict: "supported",
          evidenceIds: ["invented::0000"],
          rationale: "Invented citation.",
        },
      ],
    };
    const control = controller([
      {
        units: [
          {
            unitId: "guide::0000::unit-0000",
            classification: "factual",
            rationale: "Factual test unit.",
            assertions: ["A valid claim.", "A broken claim."],
          },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "supported",
            evidenceIds: ["source-00::0000"],
            rationale: "Visible source evidence.",
          },
          ...invalidItem.evaluations,
        ],
      },
      invalidItem,
      invalidItem,
    ]);

    const evaluations = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T0",
      activeFacts: [],
      sections: [section("guide::0000", "Two material claims.")],
      evidence: evidence(["source truth"]),
    });

    expect(evaluations.map((evaluation) => evaluation.verdict)).toEqual([
      "supported",
      "indeterminate",
    ]);
  });

  test("returns unsupported deterministically when no source evidence exists", async () => {
    const control = controller([
      {
        units: [
          {
            unitId: "guide::0000::unit-0000",
            classification: "factual",
            assertions: ["A material claim."],
            rationale: "Factual test unit.",
          },
        ],
      },
    ]);

    const evaluations = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T0",
      activeFacts: [],
      sections: [section("guide::0000", "A material claim.")],
      evidence: evidence([]),
    });

    expect(evaluations[0]).toMatchObject({
      verdict: "unsupported",
      unsupportedReason: "not-established",
      evidenceIds: [],
    });
    expect(control.systemPrompts).toEqual([PRECISION_EXTRACTION_SYSTEM]);
  });

  test("returns no judgments when extraction finds no material claims", async () => {
    const control = controller([
      {
        units: [
          {
            unitId: "guide::0000::unit-0000",
            classification: "navigation",
            assertions: [],
            rationale: "The unit only routes the reader.",
          },
        ],
      },
    ]);

    const evaluations = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T0",
      activeFacts: [],
      sections: [section("guide::0000", "See another page.")],
      evidence: evidence(["source truth"]),
    });

    expect(evaluations).toEqual([]);
    expect(control.systemPrompts).toEqual([PRECISION_EXTRACTION_SYSTEM]);
  });
});
