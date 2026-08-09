import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { resolveCoverage } from "./coverage.js";
import { EvaluationError } from "../core/errors.js";
import { runEvaluatorPass } from "./evaluator.js";
import { coverageOutputSchema } from "./schemas.js";
import type { ActiveTruthFact } from "../core/types.js";

/**
 * Shared control state for the faked deepagents module. `responses` is the queue
 * of `structuredResponse` payloads returned by successive `agent.invoke` calls,
 * and `invocations` counts how many times the agent was invoked so a test can
 * assert whether the single retry fired.
 */
const controller = vi.hoisted(() => ({
  responses: [] as unknown[],
  invocations: 0,
}));

// Replace deepagents so no real model, backend, or filesystem access is needed:
// the fake backend is inert and the fake agent just dequeues a canned response.
vi.mock("deepagents", () => ({
  FilesystemBackend: class FakeFilesystemBackend {
    constructor(_options: unknown) {}
  },
  createDeepAgent: () => ({
    invoke: async () => {
      controller.invocations += 1;
      return { structuredResponse: controller.responses.shift() };
    },
  }),
}));

/**
 * The model is never used by the faked agent, so a bare cast keeps the tests
 * focused on `runEvaluatorPass`'s own control flow.
 */
const model = {} as unknown as BaseChatModel;

beforeEach(() => {
  controller.responses = [];
  controller.invocations = 0;
});

describe("runEvaluatorPass", () => {
  test("returns the parsed output and applies schema defaults on first success", async () => {
    controller.responses = [
      {
        evaluations: [{ factId: "a", verdict: "correct", rationale: "ok" }],
      },
    ];

    const result = await runEvaluatorPass({
      model,
      workspaceDir: "/unused",
      systemPrompt: "system",
      taskPrompt: "task",
      schema: coverageOutputSchema,
    });

    expect(controller.invocations).toBe(1);
    expect(result.evaluations[0].verdict).toBe("correct");
    // The re-parse inside the pass fills the omitted evidence default.
    expect(result.evaluations[0].evidence).toEqual([]);
  });

  test("retries once when the first response fails schema validation", async () => {
    controller.responses = [
      { evaluations: [{ factId: "a", verdict: "bogus", rationale: "" }] },
      { evaluations: [{ factId: "a", verdict: "missing", rationale: "" }] },
    ];

    const result = await runEvaluatorPass({
      model,
      workspaceDir: "/unused",
      systemPrompt: "system",
      taskPrompt: "task",
      schema: coverageOutputSchema,
    });

    expect(controller.invocations).toBe(2);
    expect(result.evaluations[0].verdict).toBe("missing");
  });

  test("retries once when the completeness check throws, then succeeds", async () => {
    const activeFacts: ActiveTruthFact[] = [
      { factId: "a", factVersionId: "a@T0", category: "x", statement: "A" },
      { factId: "b", factVersionId: "b@T0", category: "x", statement: "B" },
    ];

    controller.responses = [
      // Schema-valid but incomplete: `b` has no verdict, so resolveCoverage throws.
      { evaluations: [{ factId: "a", verdict: "correct", rationale: "" }] },
      {
        evaluations: [
          { factId: "a", verdict: "correct", rationale: "" },
          { factId: "b", verdict: "missing", rationale: "" },
        ],
      },
    ];

    const result = await runEvaluatorPass({
      model,
      workspaceDir: "/unused",
      systemPrompt: "system",
      taskPrompt: "task",
      schema: coverageOutputSchema,
      validate: (parsed) => {
        resolveCoverage(activeFacts, parsed);
      },
    });

    expect(controller.invocations).toBe(2);
    expect(result.evaluations).toHaveLength(2);
  });

  test("throws EvaluationError after two failures without a third attempt", async () => {
    controller.responses = [
      { evaluations: [{ factId: "a", verdict: "bogus", rationale: "" }] },
      { evaluations: [{ factId: "a", verdict: "alsobogus", rationale: "" }] },
    ];

    await expect(
      runEvaluatorPass({
        model,
        workspaceDir: "/unused",
        systemPrompt: "system",
        taskPrompt: "task",
        schema: coverageOutputSchema,
      }),
    ).rejects.toBeInstanceOf(EvaluationError);

    expect(controller.invocations).toBe(2);
  });
});
