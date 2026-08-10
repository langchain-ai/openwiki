import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { describe, expect, test } from "vitest";

import type { EvidenceCorpus, EvaluationWarning } from "../core/types.js";
import type { ArtifactSection } from "./documents.js";
import {
  type PrecisionAssertionInventory,
  runPrecisionPass,
} from "./precision.js";
import {
  PRECISION_EXTRACTION_SYSTEM,
  PRECISION_JUDGMENT_SYSTEM,
  PRECISION_LEDGER_SYSTEM,
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
  return {
    id: "guide.md::0000",
    relativePath: "guide.md",
    headingPath: ["Guide"],
    ordinal: 0,
    content,
    searchableText: content,
  };
}

function sectionWithId(id: string, content: string): ArtifactSection {
  return {
    id,
    relativePath: id.split("::")[0],
    headingPath: ["Guide"],
    ordinal: 0,
    content,
    searchableText: content,
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
          tense: assertion.tense ?? "current",
        })),
        rationale: "Atomic factual claims.",
      },
    ],
  };
}

describe("runPrecisionPass", () => {
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
            factVersionIds: ["add@T0"],
            rationale: "Current truth ledger establishes add.",
          },
          {
            assertionId: "assertion-000002",
            verdict: "supported",
            factVersionIds: ["negate@T0"],
            rationale: "Superseded truth establishes the historical removal.",
          },
        ],
      },
    ]);
    let inventory: PrecisionAssertionInventory | undefined;

    const result = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T1",
      sections: [section("one block")],
      activeFacts: [
        {
          factId: "add",
          factVersionId: "add@T0",
          category: "api",
          statement: "add returns a + b",
        },
      ],
      supersededFacts: [
        {
          factId: "negate",
          factVersionId: "negate@T0",
          obsoleteStatement: "negate exists",
        },
      ],
      evidence: evidence(),
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

  test("routes ledger contradictions to invented or stale", async () => {
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
            factVersionIds: ["version@T1"],
            formerlyTrue: false,
            rationale: "Current version is 2.0.0 and 9.0.0 was never true.",
          },
          {
            assertionId: "assertion-000002",
            verdict: "contradicted",
            factVersionIds: ["version@T1", "version@T0"],
            formerlyTrue: true,
            rationale: "1.0.0 was true before the current 2.0.0 version.",
          },
        ],
      },
    ]);

    const result = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T1",
      sections: [section("versions")],
      activeFacts: [
        {
          factId: "version",
          factVersionId: "version@T1",
          category: "release",
          statement: "VERSION is 2.0.0",
        },
      ],
      supersededFacts: [
        {
          factId: "version",
          factVersionId: "version@T0",
          obsoleteStatement: "VERSION is 1.0.0",
        },
      ],
      evidence: evidence(),
    });

    expect(result).toMatchObject([
      { verdict: "invented", adjudicatedBy: "ledger" },
      { verdict: "stale", adjudicatedBy: "ledger" },
    ]);
  });

  test("leaves unaccounted historical claims unverified without source calls", async () => {
    const control = controller([
      extraction([
        { statement: "A release happened in 2019", tense: "historical" },
      ]),
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "unaccounted",
            factVersionIds: [],
            rationale: "The truth ledger is silent.",
          },
        ],
      },
    ]);

    const [result] = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T1",
      sections: [section("history")],
      activeFacts: [
        {
          factId: "other",
          factVersionId: "other@T1",
          category: "test",
          statement: "Another fact",
        },
      ],
      evidence: evidence(["contradictory source should never be queried"]),
    });

    expect(result).toMatchObject({
      verdict: "unverified",
      tense: "historical",
      adjudicatedBy: "none",
    });
    expect(control.responses).toHaveLength(0);
  });

  test("runs one top-k refutation and distinguishes invented, stale, and unverified", async () => {
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
            evidenceIds: ["current-0", "historical-0"],
            formerlyTrue: true,
            rationale:
              "Current beta refutes alpha, which historical source established.",
          },
          {
            assertionId: "assertion-000003",
            verdict: "not-refuted",
            evidenceIds: [],
            rationale: "Supplied source does not refute the preference claim.",
          },
        ],
      },
    ]);

    const result = await runPrecisionPass({
      model: fakeModel(control),
      checkpointId: "T1",
      sections: [section("claims")],
      activeFacts: [],
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
    ]);
  });

  test("repairs malformed refutation in isolation and degrades failure to unverified", async () => {
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
      activeFacts: [],
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

  test("degrades one malformed refutation element without failing valid neighbors", async () => {
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
            rationale: "Current source refutes gamma.",
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
      activeFacts: [],
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
            assertions: [{ statement: "A is true", tense: "current" }],
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
            assertions: [{ statement: "B is true", tense: "current" }],
            rationale: "States a checkable fact.",
          },
        ],
      },
      // One refutation batch leaves both surviving claims unverified.
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "not-refuted",
            evidenceIds: [],
            rationale: "Not refuted.",
          },
          {
            assertionId: "assertion-000002",
            verdict: "not-refuted",
            evidenceIds: [],
            rationale: "Not refuted.",
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
      activeFacts: [],
      evidence: evidence(["some source"]),
      onWarning: (warning) => warnings.push(warning),
    });

    expect(result.map((item) => item.assertion)).toEqual([
      "A is true",
      "B is true",
    ]);
    expect(warnings).toHaveLength(0);
  });

  test("degrades an unrecoverable extraction unit to a warned no-claim unit", async () => {
    const control = controller([
      // The batch response drops the second requested unit.
      {
        units: [
          {
            unitId: "guide.md::0000::unit-0000",
            classification: "factual",
            assertions: [{ statement: "A is true", tense: "current" }],
            rationale: "States a checkable fact.",
          },
        ],
      },
      new Error("isolated extraction failed once"),
      new Error("isolated extraction failed twice"),
      // Only the surviving claim reaches refutation.
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "not-refuted",
            evidenceIds: [],
            rationale: "Not refuted.",
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
      activeFacts: [],
      evidence: evidence(["some source"]),
      onWarning: (warning) => warnings.push(warning),
    });

    expect(result.map((item) => item.assertion)).toEqual(["A is true"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].pass).toBe("precision-extraction");
    expect(warnings[0].itemId).toBe("guide.md::0001::unit-0000");
  });

  test("uses extraction as the sole semantic filter taxonomy", () => {
    expect(PRECISION_EXTRACTION_SYSTEM).toContain('"meta-artifact"');
    expect(PRECISION_EXTRACTION_SYSTEM).toContain(
      "one independently judgeable claim",
    );
    expect(PRECISION_EXTRACTION_SYSTEM).toContain('"historical"');
    expect(PRECISION_LEDGER_SYSTEM).toContain(
      "ledger silence is not contradiction",
    );
    expect(PRECISION_JUDGMENT_SYSTEM).toContain(
      "Never certify an assertion true",
    );
  });
});
