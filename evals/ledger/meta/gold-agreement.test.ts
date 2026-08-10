import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { describe, expect, test } from "vitest";

import {
  assertGoldAgreement,
  loadPrecisionGoldFixture,
  measureGoldAgreement,
} from "./gold-agreement.js";

function fakeModel(responses: unknown[]): BaseChatModel {
  const queue = [...responses];
  return {
    withStructuredOutput: () => ({ invoke: async () => queue.shift() }),
  } as unknown as BaseChatModel;
}

describe("precision gold agreement", () => {
  test("reports perfect agreement for human-labeled stage outputs", async () => {
    const fixture = await loadPrecisionGoldFixture();
    const responses: unknown[] = [
      {
        units: fixture.extractionCases.map((item, index) => ({
          unitId: `gold-unit-${index}`,
          ...item.expected,
          rationale: "Human-labeled fixture response.",
        })),
      },
      ...fixture.ledgerCases.map((item, index) => ({
        evaluations: [
          {
            assertionId: `gold-ledger-${index}`,
            verdict: item.expected.verdict,
            formerlyTrue: item.expected.formerlyTrue,
            factVersionIds:
              item.expected.verdict === "unaccounted"
                ? []
                : item.facts.map((fact) => fact.factVersionId),
            rationale: "Human-labeled fixture response.",
          },
        ],
      })),
      ...fixture.refutationCases.map((item, index) => ({
        evaluations: [
          {
            assertionId: `gold-refutation-${index}`,
            verdict: item.expected.verdict,
            formerlyTrue: item.expected.formerlyTrue,
            evidenceIds:
              item.expected.verdict === "contradicted"
                ? item.evidence.map((evidence) => evidence.evidenceId)
                : [],
            rationale: "Human-labeled fixture response.",
          },
        ],
      })),
    ];

    const report = await measureGoldAgreement({
      model: fakeModel(responses),
      fixture,
    });

    expect(report).toMatchObject({
      extraction: { agreement: 1 },
      ledger: { agreement: 1 },
      refutation: { agreement: 1 },
      floor: 0.9,
      passed: true,
    });
    expect(() => assertGoldAgreement(report)).not.toThrow();
  });

  test("fails the gate when one stage falls below the shared floor", () => {
    expect(() =>
      assertGoldAgreement({
        extraction: { correct: 8, total: 10, agreement: 0.8, mismatches: [] },
        ledger: { correct: 5, total: 5, agreement: 1, mismatches: [] },
        refutation: { correct: 4, total: 4, agreement: 1, mismatches: [] },
        floor: 0.9,
        passed: false,
      }),
    ).toThrow(/gold agreement below 0\.9/u);
  });
});
