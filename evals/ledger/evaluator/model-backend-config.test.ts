import { beforeEach, describe, expect, test, vi } from "vitest";

const modelCalls = vi.hoisted(() => [] as unknown[][]);
const fakeModel = vi.hoisted(() => ({}));

vi.mock("../../../src/agent/index.js", () => ({
  createModel: (...args: unknown[]) => {
    modelCalls.push(args);
    return fakeModel;
  },
}));

const { ModelEvaluationBackend } = await import("./model-backend.js");

beforeEach(() => {
  modelCalls.length = 0;
});

describe("ModelEvaluationBackend model configuration", () => {
  test("disables provider retries without forcing sampling parameters", () => {
    new ModelEvaluationBackend({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
    });

    expect(modelCalls).toEqual([["anthropic", "claude-sonnet-5", 0]]);
    expect(fakeModel).toEqual({});
  });
});
