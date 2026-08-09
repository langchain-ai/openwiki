import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Mutable state shared with the evaluator model test double.
 */
interface ModelControl {
  /**
   * Structured responses consumed in invocation order.
   */
  responses: unknown[];

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
  responses: [],
  systemPrompts: [],
  active: 0,
  maxActive: 0,
}));

const fakeModel = vi.hoisted(() => ({
  temperature: undefined as number | undefined,
  withStructuredOutput: () => ({
    invoke: async (messages: Array<{ role: string; content: string }>) => {
      control.systemPrompts.push(messages[0].content);
      control.active += 1;
      control.maxActive = Math.max(control.maxActive, control.active);

      try {
        await Promise.resolve();
        return control.responses.shift();
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
  COVERAGE_SYSTEM,
  FORGETTING_SYSTEM,
  PRECISION_EXTRACTION_SYSTEM,
  PRECISION_JUDGMENT_SYSTEM,
} = await import("./prompts.js");

beforeEach(() => {
  control.responses.length = 0;
  control.systemPrompts.length = 0;
  control.active = 0;
  control.maxActive = 0;
});

describe("ModelEvaluationBackend", () => {
  test("runs the complete bounded pipeline sequentially from artifact documents", async () => {
    control.responses.push(
      {
        evaluations: [
          {
            factId: "current",
            verdict: "correct",
            evidence: ["guide.md::0000"],
            rationale: "The artifact states the active fact.",
          },
        ],
      },
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
      {
        sections: [
          {
            sectionId: "guide.md::0000",
            assertions: ["Current behavior is enabled."],
          },
        ],
      },
      {
        evaluations: [
          {
            assertionId: "assertion-000001",
            verdict: "supported",
            supportingFactIds: ["current"],
            rationale: "The active ledger supports the assertion.",
          },
        ],
      },
    );

    const backend = new ModelEvaluationBackend({
      provider: "anthropic",
      modelId: "test-model",
    });
    const result = await backend.evaluate({
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
      activeFacts: [
        {
          factId: "current",
          factVersionId: "current@T1",
          category: "behavior",
          statement: "Current behavior is enabled.",
        },
      ],
      obsoleteFacts: [
        {
          factId: "old",
          factVersionId: "old@T0",
          obsoleteStatement: "Old behavior is enabled.",
        },
      ],
    });

    expect(backend.version).toBe("keb-eval-3");
    expect(control.systemPrompts).toEqual([
      COVERAGE_SYSTEM,
      FORGETTING_SYSTEM,
      PRECISION_EXTRACTION_SYSTEM,
      PRECISION_JUDGMENT_SYSTEM,
    ]);
    expect(control.maxActive).toBe(1);
    expect(result).toEqual({
      factEvaluations: [
        {
          factId: "current",
          factVersionId: "current@T1",
          verdict: "correct",
          evidence: ["guide.md::0000"],
          rationale: "The artifact states the active fact.",
        },
      ],
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
          location: "guide.md",
          verdict: "supported",
          supportingFactIds: ["current"],
          rationale: "The active ledger supports the assertion.",
        },
      ],
    });
  });
});
