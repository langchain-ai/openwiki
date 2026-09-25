import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { describe, expect, test } from "vitest";

import type { EvidenceCorpus, EvaluationWarning } from "../core/types.js";
import type { ArtifactSection } from "./documents.js";
import {
  type PrecisionAssertionInventory,
  type PrecisionVerdictCache,
  runPrecisionPass,
} from "./precision.js";
import {
  PRECISION_EXTRACTION_SYSTEM,
  PRECISION_HISTORY_JUDGMENT_SYSTEM,
  PRECISION_JUDGMENT_SYSTEM,
} from "./prompts.js";

interface ModelControl {
  responses: Array<unknown | Error>;
  systemPrompts: string[];
  taskPrompts: string[];
}

function controller(responses: Array<unknown | Error>): ModelControl {
  return { responses: [...responses], systemPrompts: [], taskPrompts: [] };
}

function fakeModel(control: ModelControl): BaseChatModel {
  return {
    withStructuredOutput: () => ({
      invoke: async (messages: Array<{ content: string }>) => {
        control.systemPrompts.push(messages[0].content);
        control.taskPrompts.push(messages[1].content);
        const response = control.responses.shift();
        if (response instanceof Error) throw response;
        return response;
      },
    }),
  } as unknown as BaseChatModel;
}

function section(content: string): ArtifactSection {
  const contextualContent = `[source quote]\n${content}`;
  return {
    id: "guide.md::0000",
    relativePath: "guide.md",
    headingPath: ["Guide"],
    ordinal: 0,
    content: contextualContent,
    searchableText: contextualContent,
  };
}

function sectionWithId(id: string, content: string): ArtifactSection {
  const contextualContent = `[source quote]\n${content}`;
  return {
    id,
    relativePath: id.split("::")[0],
    headingPath: ["Guide"],
    ordinal: 0,
    content: contextualContent,
    searchableText: contextualContent,
  };
}

function evidence(
  current: string[] = [],
  historical: string[] = [],
): EvidenceCorpus {
  return {
    checkpointId: "T1",
    records: [
      ...current.map((content, index) => ({
        evidenceId: `current-${index}`,
        sourceRef: `current-${index}.ts`,
        observedAtCheckpoint: "T1",
        current: true,
        content,
      })),
      ...historical.map((content, index) => ({
        evidenceId: `historical-${index}`,
        sourceRef: `historical-${index}.ts`,
        observedAtCheckpoint: "T0",
        current: false,
        content,
      })),
    ],
  };
}

function extraction(
  assertions: Array<{
    statement: string;
    tense?: "current" | "historical";
  }>,
  classification: "factual" | "mixed" = "factual",
): unknown {
  return {
    units: [
      {
        unitId: "guide.md::0000::unit-0000",
        classification,
        assertions: assertions.map((assertion) => ({
          statement: assertion.statement,
          sourceQuote: "[source quote]",
          tense: assertion.tense ?? "current",
        })),
        rationale: "Atomic factual claims.",
      },
    ],
  };
}

describe("runPrecisionPass", () => {
  test("keeps a colon-led list with the paragraph that identifies its subject", async () => {
    const content =
      "The focused test is test/queue.test.ts:\n\n- This file does not import worker.ts.\n";
    const control = controller([
      {
        units: [
          {
            unitId: "guide.md::0000::unit-0000",
            classification: "factual",
            assertions: [
              {
                statement: "test/queue.test.ts does not import worker.ts.",
                sourceQuote: "This file does not import worker.ts.",
                tense: "current",
              },
            ],
            rationale: "The lead-in identifies the list subject.",
          },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "supported",
            evidenceIds: ["current-0"],
            rationale: "The source establishes the import boundary.",
          },
        ],
      },
    ]);
    let inventory: PrecisionAssertionInventory | undefined;

    await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T1",
      sections: [
        {
          id: "guide.md::0000",
          relativePath: "guide.md",
          headingPath: ["Focused test"],
          ordinal: 0,
          content,
          searchableText: content,
        },
      ],
      evidence: evidence(["test/queue.test.ts has no worker import"]),
      onInventory: (value) => {
        inventory = value;
      },
    });

    expect(inventory?.units).toHaveLength(1);
    expect(inventory?.units[0].content).toBe(content);
    expect(control.taskPrompts[0]).not.toContain("unit-0001");
  });

  test("extracts tense-tagged atomic claims and exact-deduplicates only", async () => {
    const control = controller([
      extraction([
        { statement: "add returns a + b" },
        { statement: "add returns a + b." },
        { statement: "negate was removed", tense: "historical" },
      ]),
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "supported",
            evidenceIds: ["current-0"],
            rationale: "Current source establishes add.",
          },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000002",
            verdict: "supported",
            evidenceIds: ["historical-0"],
            rationale: "Historical source establishes the earlier removal.",
          },
        ],
      },
    ]);
    let inventory: PrecisionAssertionInventory | undefined;

    const result = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T1",
      sections: [section("one block")],
      evidence: evidence(["add returns a + b"], ["negate was removed"]),
      onInventory: (value) => {
        inventory = value;
      },
    });

    expect(result.map(({ verdict, tense }) => ({ verdict, tense }))).toEqual([
      { verdict: "supported", tense: "current" },
      { verdict: "supported", tense: "historical" },
    ]);
    expect(inventory?.keptAssertionCount).toBe(2);
    expect(inventory?.candidates[1]).toMatchObject({
      disposition: "excluded",
      exclusionReason: "exact-duplicate",
      duplicateOf: "assertion-000001",
    });
  });

  test("grounds source contradictions to invented or stale", async () => {
    const control = controller([
      extraction([
        { statement: "VERSION is 9.0.0" },
        { statement: "VERSION is 1.0.0" },
      ]),
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "contradicted",
            evidenceIds: ["current-0"],
            formerlyTrue: false,
            rationale: "Current source is 2.0.0, not 9.0.0.",
          },
          {
            assertionId: "assertion-000002",
            verdict: "contradicted",
            evidenceIds: ["current-0"],
            formerlyTrue: false,
            rationale: "Current source is 2.0.0, not 1.0.0.",
          },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "not-addressed",
            evidenceIds: [],
            rationale: "Historical source never establishes 9.0.0.",
          },
          {
            assertionId: "assertion-000002",
            verdict: "supported",
            evidenceIds: ["historical-0"],
            rationale: "Historical source establishes 1.0.0.",
          },
        ],
      },
    ]);

    const result = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T1",
      sections: [section("versions")],
      evidence: evidence(["VERSION is 2.0.0"], ["VERSION is 1.0.0"]),
    });

    expect(result).toMatchObject([
      { verdict: "invented", adjudicatedBy: "source" },
      { verdict: "stale", adjudicatedBy: "source" },
    ]);
  });

  test("keeps current named paths and the manifest out of historical BM25 crowding", async () => {
    const control = controller([
      extraction([
        { statement: "src/version.ts contains a standalone VERSION constant" },
        { statement: "There is no package.json in the repository" },
      ]),
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "supported",
            evidenceIds: ["src/version.ts::0000"],
            rationale: "The named current file defines VERSION.",
          },
          {
            assertionId: "assertion-000002",
            verdict: "supported",
            evidenceIds: ["git:tracked-files"],
            rationale: "The complete current manifest omits package.json.",
          },
        ],
      },
    ]);
    let inventory: PrecisionAssertionInventory | undefined;
    const filler = "package repository version constant ".repeat(200);
    const corpus: EvidenceCorpus = {
      checkpointId: "T2",
      records: [
        {
          evidenceId: "git:tracked-files",
          sourceRef: "git tracked files",
          observedAtCheckpoint: "T2",
          current: true,
          content: "Tracked files:\n- README.md\n- src/version.ts",
        },
        ...Array.from({ length: 10 }, (_, index) => ({
          evidenceId: `notes-${index}::0000`,
          sourceRef: `notes-${index}.md`,
          observedAtCheckpoint: "T2",
          current: true,
          content: filler,
        })),
        {
          evidenceId: "src/version.ts::0000",
          sourceRef: "src/version.ts",
          observedAtCheckpoint: "T2",
          current: true,
          content: 'export const VERSION = "2.0.0";',
        },
        {
          evidenceId: "T0:src/version.ts::0000",
          sourceRef: "src/version.ts",
          observedAtCheckpoint: "T0",
          current: false,
          content: 'export const VERSION = "1.0.0";',
        },
        {
          evidenceId: "T0:git:tracked-files",
          sourceRef: "git tracked files",
          observedAtCheckpoint: "T0",
          current: false,
          content:
            "Tracked files reported by git ls-files at checkpoint T0:\n- README.md\n- src/version.ts",
        },
        {
          evidenceId: "T1:git:tracked-files",
          sourceRef: "git tracked files",
          observedAtCheckpoint: "T1",
          current: false,
          content:
            "Tracked files reported by git ls-files at checkpoint T1:\n- README.md\n- src/version.ts",
        },
        {
          evidenceId: "T1:src/version.ts::0000",
          sourceRef: "src/version.ts",
          observedAtCheckpoint: "T1",
          current: false,
          content: 'export const VERSION = "1.0.0";',
        },
      ],
    };

    await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T2",
      sections: [section("claims")],
      evidence: corpus,
      onInventory: (value) => {
        inventory = value;
      },
    });

    const currentPromptIndex = control.systemPrompts.indexOf(
      PRECISION_JUDGMENT_SYSTEM,
    );
    const currentPrompt = control.taskPrompts[currentPromptIndex];
    expect(currentPrompt).toContain('"evidenceId": "src/version.ts::0000"');
    expect(currentPrompt).toContain('"evidenceId": "git:tracked-files"');
    expect(currentPrompt).not.toContain('"evidenceId": "T0:');
    expect(currentPrompt).not.toContain('"evidenceId": "T1:');

    const namedPath = inventory?.groundingEvidence[0];
    expect(namedPath?.currentEvidenceIds).toContain("src/version.ts::0000");
    expect(
      namedPath?.historicalEvidenceIds.filter((id) =>
        id.includes("src/version.ts"),
      ),
    ).toHaveLength(1);
    expect(inventory?.groundingEvidence[1]?.currentEvidenceIds).toContain(
      "git:tracked-files",
    );
    expect(
      inventory?.groundingEvidence[1]?.historicalEvidenceIds.filter((id) =>
        id.includes("git:tracked-files"),
      ),
    ).toHaveLength(1);
  });

  test("makes evidence-map routes mandatory and records their provenance", async () => {
    const control = controller([
      extraction([{ statement: "The oldest task leaves the queue first." }]),
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "supported",
            evidenceIds: ["src/queue.ts::0000"],
            rationale: "The queue implementation establishes the behavior.",
          },
        ],
      },
    ]);
    let inventory: PrecisionAssertionInventory | undefined;
    const distractingContent = "oldest task queue first ".repeat(400);
    const corpus: EvidenceCorpus = {
      checkpointId: "T1",
      records: [
        ...Array.from({ length: 10 }, (_, index) => ({
          evidenceId: `notes-${index}::0000`,
          sourceRef: `notes-${index}.md`,
          observedAtCheckpoint: "T1",
          current: true,
          content: distractingContent,
        })),
        {
          evidenceId: "src/queue.ts::0000",
          sourceRef: "src/queue.ts",
          observedAtCheckpoint: "T1",
          current: true,
          content: "return queue.tasks.shift();",
        },
      ],
    };

    await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T1",
      sections: [section("queue behavior")],
      evidence: corpus,
      evidenceMap: {
        entries: [
          {
            id: "queue-ordering",
            concept: "task queue ordering oldest newest insertion and removal",
            evidence: ["src/queue.ts#dequeue"],
          },
        ],
      },
      onInventory: (value) => {
        inventory = value;
      },
    });

    const grounding = inventory?.groundingEvidence[0];
    expect(grounding?.currentEvidenceIds).toContain("src/queue.ts::0000");
    expect(grounding).toMatchObject({
      evidenceMapEntryIds: ["queue-ordering"],
      evidenceMapSelectors: ["src/queue.ts#dequeue"],
      currentEvidenceMapSourceRefs: ["src/queue.ts"],
      historicalEvidenceMapSourceRefs: [],
    });
  });

  test("marks claims unverified without a model call when no source evidence exists", async () => {
    const control = controller([
      extraction([
        { statement: "A release happened in 2019", tense: "historical" },
      ]),
    ]);

    const [result] = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T1",
      sections: [section("history")],
      evidence: evidence(),
    });

    expect(result).toMatchObject({
      verdict: "unverified",
      tense: "historical",
      adjudicatedBy: "none",
    });
    // Extraction ran, but the empty corpus short-circuits grounding with no call.
    expect(control.responses).toHaveLength(0);
    expect(control.systemPrompts).toEqual([PRECISION_EXTRACTION_SYSTEM]);
  });

  test("runs one grounding batch and distinguishes invented, stale, and unverified", async () => {
    const control = controller([
      extraction([
        { statement: "flag is gamma" },
        { statement: "flag is alpha" },
        { statement: "maintainers prefer tabs" },
      ]),
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "contradicted",
            evidenceIds: ["current-0"],
            formerlyTrue: false,
            rationale: "Current source says beta, not gamma.",
          },
          {
            assertionId: "assertion-000002",
            verdict: "contradicted",
            evidenceIds: ["current-0"],
            formerlyTrue: false,
            rationale: "Current beta contradicts alpha.",
          },
          {
            assertionId: "assertion-000003",
            verdict: "not-addressed",
            evidenceIds: [],
            rationale:
              "Supplied source neither confirms nor denies the preference.",
          },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "not-addressed",
            evidenceIds: [],
            rationale: "Historical source does not establish gamma.",
          },
          {
            assertionId: "assertion-000002",
            verdict: "supported",
            evidenceIds: ["historical-0"],
            rationale: "Historical source establishes alpha.",
          },
        ],
      },
    ]);

    const result = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T1",
      sections: [section("claims")],
      evidence: evidence(["flag = beta"], ["flag = alpha"]),
    });

    expect(result).toMatchObject([
      { verdict: "invented", adjudicatedBy: "source" },
      { verdict: "stale", adjudicatedBy: "source" },
      { verdict: "unverified", adjudicatedBy: "none" },
    ]);
    expect(control.systemPrompts).toEqual([
      PRECISION_EXTRACTION_SYSTEM,
      PRECISION_JUDGMENT_SYSTEM,
      PRECISION_HISTORY_JUDGMENT_SYSTEM,
    ]);
  });

  test("repairs a malformed grounding element in isolation and degrades to unverified", async () => {
    const control = controller([
      extraction([{ statement: "flag is gamma" }]),
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "contradicted",
            evidenceIds: ["missing"],
            formerlyTrue: false,
            rationale: "Bad citation.",
          },
        ],
      },
      new Error("repair failed once"),
      new Error("repair failed twice"),
    ]);
    const warnings: EvaluationWarning[] = [];

    const [result] = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T1",
      sections: [section("claim")],
      evidence: evidence(["flag = beta"]),
      onWarning: (warning) => warnings.push(warning),
    });

    expect(result).toMatchObject({
      verdict: "unverified",
      adjudicatedBy: "none",
      evidenceIds: [],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].pass).toBe("precision-judgment");
  });

  test("degrades one malformed grounding element without failing valid neighbors", async () => {
    const control = controller([
      extraction([
        { statement: "flag is gamma" },
        { statement: "maintainers prefer tabs" },
      ]),
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "contradicted",
            evidenceIds: ["current-0"],
            formerlyTrue: false,
            rationale: "Current source contradicts gamma.",
          },
          {
            // Malformed: a contradicted verdict with formerlyTrue omitted.
            // Under the old strict batch schema this failed the whole array
            // parse and crashed the run; now it is isolated per target.
            assertionId: "assertion-000002",
            verdict: "contradicted",
            evidenceIds: ["current-0"],
            rationale: "Model waffled and omitted formerlyTrue.",
          },
        ],
      },
      new Error("isolated repair failed once"),
      new Error("isolated repair failed twice"),
    ]);
    const warnings: EvaluationWarning[] = [];

    const result = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T1",
      sections: [section("claims")],
      evidence: evidence(["flag = beta"]),
      onWarning: (warning) => warnings.push(warning),
    });

    expect(result).toMatchObject([
      { verdict: "invented", adjudicatedBy: "source" },
      { verdict: "unverified", adjudicatedBy: "none" },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].pass).toBe("precision-judgment");
  });

  test("repairs a dropped extraction unit in isolation without failing the pass", async () => {
    const control = controller([
      // The batch response drops the second requested unit entirely.
      {
        units: [
          {
            unitId: "guide.md::0000::unit-0000",
            classification: "factual",
            assertions: [
              {
                statement: "A is true",
                sourceQuote: "[source quote]",
                tense: "current",
              },
            ],
            rationale: "States a checkable fact.",
          },
        ],
      },
      // Isolated re-extraction recovers the dropped unit.
      {
        units: [
          {
            unitId: "guide.md::0001::unit-0000",
            classification: "factual",
            assertions: [
              {
                statement: "B is true",
                sourceQuote: "[source quote]",
                tense: "current",
              },
            ],
            rationale: "States a checkable fact.",
          },
        ],
      },
      // One grounding batch leaves both surviving claims not-addressed.
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "not-addressed",
            evidenceIds: [],
            rationale: "Not addressed.",
          },
          {
            assertionId: "assertion-000002",
            verdict: "not-addressed",
            evidenceIds: [],
            rationale: "Not addressed.",
          },
        ],
      },
    ]);
    const warnings: EvaluationWarning[] = [];

    const result = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T1",
      sections: [
        sectionWithId("guide.md::0000", "claim A"),
        sectionWithId("guide.md::0001", "claim B"),
      ],
      evidence: evidence(["some source"]),
      onWarning: (warning) => warnings.push(warning),
    });

    expect(result.map((item) => item.assertion)).toEqual([
      "A is true",
      "B is true",
    ]);
    expect(warnings).toHaveLength(0);
  });

  test("degrades a failed grounding batch instead of aborting the pass", async () => {
    const control = controller([
      extraction([{ statement: "A is true" }, { statement: "B is true" }]),
      new Error("connection failed once"),
      new Error("connection failed twice"),
    ]);
    const warnings: EvaluationWarning[] = [];

    const result = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T1",
      sections: [section("claims")],
      evidence: evidence(["some source"]),
      onWarning: (warning) => warnings.push(warning),
    });

    expect(result).toMatchObject([
      { assertion: "A is true", verdict: "unverified", adjudicatedBy: "none" },
      { assertion: "B is true", verdict: "unverified", adjudicatedBy: "none" },
    ]);
    expect(warnings).toHaveLength(2);
    expect(
      warnings.every((warning) => warning.pass === "precision-judgment"),
    ).toBe(true);
    expect(warnings.map((warning) => warning.itemId)).toEqual([
      "assertion-000001",
      "assertion-000002",
    ]);
    expect(control.responses).toHaveLength(0);
  });

  test("degrades an unrecoverable extraction unit to a warned no-claim unit", async () => {
    const control = controller([
      // The batch response drops the second requested unit.
      {
        units: [
          {
            unitId: "guide.md::0000::unit-0000",
            classification: "factual",
            assertions: [
              {
                statement: "A is true",
                sourceQuote: "[source quote]",
                tense: "current",
              },
            ],
            rationale: "States a checkable fact.",
          },
        ],
      },
      new Error("isolated extraction failed once"),
      new Error("isolated extraction failed twice"),
      // Only the surviving claim reaches grounding.
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "not-addressed",
            evidenceIds: [],
            rationale: "Not addressed.",
          },
        ],
      },
    ]);
    const warnings: EvaluationWarning[] = [];

    const result = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T1",
      sections: [
        sectionWithId("guide.md::0000", "claim A"),
        sectionWithId("guide.md::0001", "claim B"),
      ],
      evidence: evidence(["some source"]),
      onWarning: (warning) => warnings.push(warning),
    });

    expect(result.map((item) => item.assertion)).toEqual(["A is true"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].pass).toBe("precision-extraction");
    expect(warnings[0].itemId).toBe("guide.md::0001::unit-0000");
  });

  test("recovers from an empty batch tool-call payload without crashing the pass", async () => {
    const control = controller([
      // Degenerate empty structured-output payload: Anthropic structured output
      // is forced tool use, and the model can return `{}` with no `units` key.
      // The tolerant schema parses this to an empty extraction rather than
      // throwing at the schema boundary.
      {},
      // Isolated re-extraction recovers each requested unit.
      {
        units: [
          {
            unitId: "guide.md::0000::unit-0000",
            classification: "factual",
            assertions: [
              {
                statement: "A is true",
                sourceQuote: "[source quote]",
                tense: "current",
              },
            ],
            rationale: "States a checkable fact.",
          },
        ],
      },
      {
        units: [
          {
            unitId: "guide.md::0001::unit-0000",
            classification: "factual",
            assertions: [
              {
                statement: "B is true",
                sourceQuote: "[source quote]",
                tense: "current",
              },
            ],
            rationale: "States a checkable fact.",
          },
        ],
      },
      // Grounding leaves both recovered claims not-addressed.
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "not-addressed",
            evidenceIds: [],
            rationale: "Not addressed.",
          },
          {
            assertionId: "assertion-000002",
            verdict: "not-addressed",
            evidenceIds: [],
            rationale: "Not addressed.",
          },
        ],
      },
    ]);
    const warnings: EvaluationWarning[] = [];

    const result = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T1",
      sections: [
        sectionWithId("guide.md::0000", "claim A"),
        sectionWithId("guide.md::0001", "claim B"),
      ],
      evidence: evidence(["some source"]),
      onWarning: (warning) => warnings.push(warning),
    });

    expect(result.map((item) => item.assertion)).toEqual([
      "A is true",
      "B is true",
    ]);
    expect(warnings).toHaveLength(0);
  });

  test("survives a whole-batch extraction failure by degrading each unit to a warned no-claim unit", async () => {
    const control = controller([
      // Both attempts of the batch extraction fail outright, so the batch call
      // throws instead of returning a payload.
      new Error("batch extraction failed once"),
      new Error("batch extraction failed twice"),
      // Isolated re-extraction of each unit also fails on both attempts.
      new Error("unit-0 repair failed once"),
      new Error("unit-0 repair failed twice"),
      new Error("unit-1 repair failed once"),
      new Error("unit-1 repair failed twice"),
    ]);
    const warnings: EvaluationWarning[] = [];

    const result = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T1",
      sections: [
        sectionWithId("guide.md::0000", "claim A"),
        sectionWithId("guide.md::0001", "claim B"),
      ],
      evidence: evidence(["some source"]),
      onWarning: (warning) => warnings.push(warning),
    });

    expect(result).toEqual([]);
    expect(warnings).toHaveLength(2);
    expect(warnings.map((warning) => warning.itemId)).toEqual([
      "guide.md::0000::unit-0000",
      "guide.md::0001::unit-0000",
    ]);
    expect(
      warnings.every((warning) => warning.pass === "precision-extraction"),
    ).toBe(true);
  });

  test("reuses a cached verdict across checkpoints without a second judgment call", async () => {
    const cache: PrecisionVerdictCache = new Map();
    const control = controller([
      extraction([{ statement: "add returns a + b" }]),
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "supported",
            evidenceIds: ["current-0"],
            rationale: "Current source establishes add.",
          },
        ],
      },
      // Second checkpoint re-extracts the identical claim; grounding must be
      // served from the cache, so no judgment response is queued for it.
      extraction([{ statement: "add returns a + b" }]),
    ]);
    const corpus = evidence(["add returns a + b"]);

    await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T1",
      sections: [section("one block")],
      evidence: corpus,
      verdictCache: cache,
    });
    const [second] = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T2",
      sections: [section("one block")],
      evidence: corpus,
      verdictCache: cache,
    });

    expect(second).toMatchObject({
      verdict: "supported",
      adjudicatedBy: "source",
      evidenceIds: ["current-0"],
    });
    // Both extraction responses and the single judgment response are consumed;
    // the reused verdict skips a second judgment call entirely.
    expect(control.responses).toHaveLength(0);
    expect(
      control.systemPrompts.filter(
        (prompt) => prompt === PRECISION_JUDGMENT_SYSTEM,
      ),
    ).toHaveLength(1);
  });

  test("re-judges when the claim's grounding evidence content changes", async () => {
    const cache: PrecisionVerdictCache = new Map();
    const control = controller([
      extraction([{ statement: "VERSION is 2.0.0" }]),
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "supported",
            evidenceIds: ["current-0"],
            rationale: "Source is 2.0.0.",
          },
        ],
      },
      extraction([{ statement: "VERSION is 2.0.0" }]),
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "contradicted",
            evidenceIds: ["current-0"],
            formerlyTrue: false,
            rationale: "Source now says 9.9.9.",
          },
        ],
      },
    ]);

    await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T1",
      sections: [section("versions")],
      evidence: evidence(["VERSION is 2.0.0"]),
      verdictCache: cache,
    });
    const [second] = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T2",
      sections: [section("versions")],
      // Same statement, but the grounding evidence content changed, so the
      // cache key differs and the claim is judged again.
      evidence: evidence(["VERSION is 9.9.9"]),
      verdictCache: cache,
    });

    expect(second).toMatchObject({
      verdict: "invented",
      adjudicatedBy: "source",
    });
    expect(control.responses).toHaveLength(0);
  });

  test("never caches a degraded verdict, so the claim is judged again next checkpoint", async () => {
    const cache: PrecisionVerdictCache = new Map();
    const control = controller([
      extraction([{ statement: "flag is gamma" }]),
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "contradicted",
            evidenceIds: ["missing"],
            formerlyTrue: false,
            rationale: "Bad citation.",
          },
        ],
      },
      new Error("repair failed once"),
      new Error("repair failed twice"),
      // Second checkpoint: identical claim and evidence. A cached degraded
      // verdict would short-circuit here; instead the claim must reach a fresh
      // judgment that resolves cleanly.
      extraction([{ statement: "flag is gamma" }]),
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "not-addressed",
            evidenceIds: [],
            rationale: "Fresh judgment: not addressed.",
          },
        ],
      },
    ]);
    const corpus = evidence(["flag = beta"]);
    const warnings: EvaluationWarning[] = [];

    const [first] = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T1",
      sections: [section("claim")],
      evidence: corpus,
      verdictCache: cache,
      onWarning: (warning) => warnings.push(warning),
    });
    const [second] = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T2",
      sections: [section("claim")],
      evidence: corpus,
      verdictCache: cache,
    });

    expect(first).toMatchObject({
      verdict: "unverified",
      adjudicatedBy: "none",
    });
    expect(warnings).toHaveLength(1);
    // The degraded verdict was not cached: the second checkpoint re-judged and
    // consumed the fresh not-addressed response.
    expect(second.rationale).toBe("Fresh judgment: not addressed.");
    expect(control.responses).toHaveLength(0);
  });

  test("uses extraction as the sole semantic filter taxonomy", () => {
    expect(PRECISION_EXTRACTION_SYSTEM).toContain('"meta-artifact"');
    expect(PRECISION_EXTRACTION_SYSTEM).toContain(
      "one independently judgeable claim",
    );
    expect(PRECISION_EXTRACTION_SYSTEM).toContain('"historical"');
    expect(PRECISION_JUDGMENT_SYSTEM).toContain("source-grounding classifier");
    expect(PRECISION_JUDGMENT_SYSTEM).toContain("silence is not contradiction");
    expect(PRECISION_EXTRACTION_SYSTEM).toContain("shared qualifier");
    expect(PRECISION_EXTRACTION_SYSTEM).toContain("complete supplied unit");
    expect(PRECISION_JUDGMENT_SYSTEM).toContain("push followed by pop");
    expect(PRECISION_JUDGMENT_SYSTEM).toContain("same complete assertion");
  });

  test("repairs an extraction whose source quote is not verbatim", async () => {
    const control = controller([
      {
        units: [
          {
            unitId: "guide.md::0000::unit-0000",
            classification: "factual",
            assertions: [
              {
                statement: "A is true",
                sourceQuote: "text absent from the unit",
                tense: "current",
              },
            ],
            rationale: "States a checkable fact.",
          },
        ],
      },
      extraction([{ statement: "A is true" }]),
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "not-addressed",
            evidenceIds: [],
            rationale: "Not addressed.",
          },
        ],
      },
    ]);
    const warnings: EvaluationWarning[] = [];

    const result = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T1",
      sections: [section("claim")],
      evidence: evidence(["some source"]),
      onWarning: (warning) => warnings.push(warning),
    });

    expect(result).toMatchObject([
      { assertion: "A is true", sourceQuote: "[source quote]" },
    ]);
    expect(warnings).toHaveLength(0);
    expect(
      control.systemPrompts.filter(
        (prompt) => prompt === PRECISION_EXTRACTION_SYSTEM,
      ),
    ).toHaveLength(2);
  });

  test("supplies one full artifact context for multiple assertions", async () => {
    const control = controller([
      extraction([{ statement: "A is true" }, { statement: "B is true" }]),
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "not-addressed",
            evidenceIds: [],
            rationale: "Not addressed.",
          },
          {
            assertionId: "assertion-000002",
            verdict: "not-addressed",
            evidenceIds: [],
            rationale: "Not addressed.",
          },
        ],
      },
    ]);

    await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T1",
      sections: [section("shared context")],
      evidence: evidence(["some source"]),
    });

    const judgmentPrompt = control.taskPrompts[1];
    expect(judgmentPrompt.match(/"artifactContextId":/gu)).toHaveLength(2);
    expect(judgmentPrompt.match(/"contextId":/gu)).toHaveLength(1);
    expect(judgmentPrompt).toContain(
      '"content": "[source quote]\\nshared context"',
    );
  });

  test("re-judges an identical claim when its artifact context changes", async () => {
    const cache: PrecisionVerdictCache = new Map();
    const control = controller([
      extraction([{ statement: "A is true" }]),
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "not-addressed",
            evidenceIds: [],
            rationale: "First context.",
          },
        ],
      },
      extraction([{ statement: "A is true" }]),
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "not-addressed",
            evidenceIds: [],
            rationale: "Changed context.",
          },
        ],
      },
    ]);
    const corpus = evidence(["some source"]);

    await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T1",
      sections: [section("first context")],
      evidence: corpus,
      verdictCache: cache,
    });
    const [second] = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T2",
      sections: [section("changed context")],
      evidence: corpus,
      verdictCache: cache,
    });

    expect(second.rationale).toBe("Changed context.");
    expect(
      control.systemPrompts.filter(
        (prompt) => prompt === PRECISION_JUDGMENT_SYSTEM,
      ),
    ).toHaveLength(2);
  });
});
