import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Mutable state shared with the evaluator model test double.
 */
interface ModelControl {
  /**
   * Structured responses queued per system prompt and consumed in order.
   *
   * The passes now run concurrently, so responses cannot be routed by a single
   * positional queue; each prompt keeps its own FIFO instead.
   */
  responsesByPrompt: Map<string, unknown[]>;

  /**
   * System prompts observed in invocation order.
   */
  systemPrompts: string[];

  /**
   * Number of model calls currently in flight.
   */
  active: number;

  /**
   * Highest number of simultaneous model calls observed.
   */
  maxActive: number;
}

const control = vi.hoisted<ModelControl>(() => ({
  responsesByPrompt: new Map<string, unknown[]>(),
  systemPrompts: [],
  active: 0,
  maxActive: 0,
}));

const fakeModel = vi.hoisted(() => ({
  withStructuredOutput: () => ({
    invoke: async (messages: Array<{ role: string; content: string }>) => {
      const prompt = messages[0].content;
      control.systemPrompts.push(prompt);
      control.active += 1;
      control.maxActive = Math.max(control.maxActive, control.active);

      try {
        await Promise.resolve();
        return control.responsesByPrompt.get(prompt)?.shift();
      } finally {
        control.active -= 1;
      }
    },
  }),
}));

vi.mock("../../../src/agent/index.js", () => ({
  createModel: () => fakeModel as unknown as BaseChatModel,
}));

const { ModelEvaluationBackend } = await import("./model-backend.js");
const {
  FORGETTING_SYSTEM,
  PRECISION_EXTRACTION_SYSTEM,
  PRECISION_JUDGMENT_SYSTEM,
} = await import("./prompts.js");

beforeEach(() => {
  control.responsesByPrompt.clear();
  control.systemPrompts.length = 0;
  control.active = 0;
  control.maxActive = 0;
});

describe("ModelEvaluationBackend", () => {
  test("runs the complete bounded pipeline concurrently from artifact documents", async () => {
    const inventories: Array<{
      checkpointId: string;
      keptAssertionCount: number;
    }> = [];
    const extractionProgress: Array<{ completed: number; total: number }> = [];
    const evaluationProgress: Array<{
      claimCount: number;
      completed: number;
      total: number;
    }> = [];
    control.responsesByPrompt.set(FORGETTING_SYSTEM, [
      {
        evaluations: [
          {
            factVersionId: "old@T0",
            verdict: "forgotten",
            evidence: [],
            rationale: "The obsolete statement is absent.",
          },
        ],
      },
    ]);
    control.responsesByPrompt.set(PRECISION_EXTRACTION_SYSTEM, [
      {
        units: [
          {
            unitId: "guide.md::0000::unit-0000",
            classification: "no-claim",
            assertions: [],
            rationale: "A heading alone makes no factual claim.",
          },
          {
            unitId: "guide.md::0000::unit-0001",
            classification: "factual",
            assertions: [
              {
                statement: "Current behavior is enabled.",
                sourceQuote: "Current behavior is enabled.",
                tense: "current",
              },
            ],
            rationale: "The unit states current behavior.",
          },
        ],
      },
    ]);
    control.responsesByPrompt.set(PRECISION_JUDGMENT_SYSTEM, [
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "supported",
            evidenceIds: ["src/current.ts::0000"],
            rationale: "Current source establishes the assertion.",
          },
        ],
      },
    ]);

    const backend = new ModelEvaluationBackend({
      provider: "anthropic",
      modelId: "test-model",
      onAssertionInventory: (inventory) => {
        inventories.push({
          checkpointId: inventory.checkpointId,
          keptAssertionCount: inventory.keptAssertionCount,
        });
      },
    });
    const result = await backend.evaluate(
      {
        artifact: {
          checkpointId: "T1",
          snapshotDir: "/snapshot-that-does-not-exist",
          fingerprint: "fixture",
          documents: [
            {
              relativePath: "guide.md",
              content: "# Guide\n\nCurrent behavior is enabled.\n",
            },
          ],
        },
        evidence: {
          checkpointId: "T1",
          records: [
            {
              evidenceId: "src/current.ts::0000",
              sourceRef: "src/current.ts",
              observedAtCheckpoint: "T1",
              current: true,
              content: "Current behavior is enabled.",
            },
          ],
        },
        obsoleteFacts: [
          {
            factId: "old",
            factVersionId: "old@T0",
            obsoleteStatement: "Old behavior is enabled.",
          },
        ],
      },
      {
        onClaimExtractionProgress: (completed, total) => {
          extractionProgress.push({ completed, total });
        },
        onClaimEvaluationProgress: (claimCount, completed, total) => {
          evaluationProgress.push({ claimCount, completed, total });
        },
      },
    );

    // Every pass runs exactly once; concurrency makes the first-wave order
    // non-deterministic, so assert the set rather than the sequence.
    expect([...control.systemPrompts].sort()).toEqual(
      [
        FORGETTING_SYSTEM,
        PRECISION_EXTRACTION_SYSTEM,
        PRECISION_JUDGMENT_SYSTEM,
      ].sort(),
    );
    // Precision's judgment still depends on its extraction, so that ordering
    // must hold even under concurrency.
    expect(
      control.systemPrompts.indexOf(PRECISION_EXTRACTION_SYSTEM),
    ).toBeLessThan(control.systemPrompts.indexOf(PRECISION_JUDGMENT_SYSTEM));
    // The three passes overlap rather than running strictly serially.
    expect(control.maxActive).toBeGreaterThan(1);
    // The first inventory is durable before judgment; the second overwrites it
    // with final cache and historical-consultation provenance.
    expect(inventories).toEqual([
      { checkpointId: "T1", keptAssertionCount: 1 },
      { checkpointId: "T1", keptAssertionCount: 1 },
    ]);
    expect(extractionProgress.at(-1)).toEqual({ completed: 2, total: 2 });
    expect(evaluationProgress.at(-1)).toEqual({
      claimCount: 1,
      completed: 2,
      total: 2,
    });
    expect(result).toEqual({
      forgettingEvaluations: [
        {
          factId: "old",
          factVersionId: "old@T0",
          verdict: "forgotten",
          evidence: [],
          rationale: "The obsolete statement is absent.",
        },
      ],
      precisionEvaluations: [
        {
          assertion: "Current behavior is enabled.",
          sourceQuote: "Current behavior is enabled.",
          location: "guide.md",
          verdict: "supported",
          tense: "current",
          adjudicatedBy: "source",
          evidenceIds: ["src/current.ts::0000"],
          rationale: "Current source establishes the assertion.",
        },
      ],
      warnings: [],
    });
  });
});
