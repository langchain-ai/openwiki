import { beforeEach, describe, expect, test, vi } from "vitest";

const modelCalls = vi.hoisted(() => [] as unknown[][]);
const fakeModel = vi.hoisted(() => ({
  temperature: undefined as number | undefined,
}));

vi.mock("../../../src/agent/index.js", () => ({
  createModel: (...args: unknown[]) => {
    modelCalls.push(args);
    return fakeModel;
  },
}));

const { ModelEvaluationBackend } = await import("./model-backend.js");

beforeEach(() => {
  modelCalls.length = 0;
  fakeModel.temperature = undefined;
});

describe("ModelEvaluationBackend model configuration", () => {
  test("disables provider retries and requests deterministic temperature", () => {
    new ModelEvaluationBackend({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
    });

    expect(modelCalls).toEqual([["anthropic", "claude-sonnet-5", 0]]);
    expect(fakeModel.temperature).toBe(0);
  });
});
