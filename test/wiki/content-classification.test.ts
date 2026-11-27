import { beforeEach, describe, expect, test, vi } from "vitest";

// classifyRecordsWithLLM reuses the real agent model-construction helpers —
// mock those so this stays a fast, offline unit test of the batching/
// parsing/vocabulary logic, not an integration test against a real provider.
const invoke = vi.fn<(messages: { content: string }[]) => Promise<{ content: string }>>();
vi.mock("../../src/agent/index.ts", () => ({
  createModel: () => ({ invoke }),
  resolveModelId: () => "fake-model",
}));
vi.mock("../../src/config/constants.ts", () => ({
  resolveConfiguredProvider: () => "anthropic",
}));

const { classifyRecordsWithLLM } = await import("../../src/wiki/content-classification.ts");

function record(id: string, title: string) {
  return { categoricalFields: new Map<string, string>(), id, title, url: undefined };
}

describe("classifyRecordsWithLLM", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  test("assigns the model's labels as a synthetic classification field", async () => {
    invoke.mockResolvedValueOnce({
      content: JSON.stringify({ "0": "Billing And Refunds", "1": "Access Control" }),
    });

    const result = await classifyRecordsWithLLM([
      record("a", "How do I get a refund"),
      record("b", "SAML setup"),
    ]);

    expect(result[0].categoricalFields.get("classification")).toBe("Billing And Refunds");
    expect(result[1].categoricalFields.get("classification")).toBe("Access Control");
  });

  test("handles a response wrapped in prose/markdown fences", async () => {
    invoke.mockResolvedValueOnce({
      content: 'Here you go:\n```json\n{"0": "Billing And Refunds"}\n```',
    });

    const result = await classifyRecordsWithLLM([record("a", "Refund question")]);
    expect(result[0].categoricalFields.get("classification")).toBe("Billing And Refunds");
  });

  test("a malformed response leaves records unlabeled instead of throwing", async () => {
    invoke.mockResolvedValueOnce({ content: "not json at all" });

    const result = await classifyRecordsWithLLM([record("a", "Something")]);
    expect(result[0].categoricalFields.has("classification")).toBe(false);
  });

  test("a failed model call leaves that batch's records unlabeled instead of throwing", async () => {
    invoke.mockRejectedValueOnce(new Error("provider down"));

    const result = await classifyRecordsWithLLM([record("a", "Something")]);
    expect(result[0].categoricalFields.has("classification")).toBe(false);
  });

  test("the growing label vocabulary is passed to later batches so labels stay consistent", async () => {
    const batch1 = Array.from({ length: 40 }, (_, i) => record(`a${i}`, `Billing question ${i}`));
    const batch2 = Array.from({ length: 5 }, (_, i) => record(`b${i}`, `More billing ${i}`));

    invoke.mockResolvedValueOnce({
      content: JSON.stringify(Object.fromEntries(batch1.map((_, i) => [String(i), "Billing And Refunds"]))),
    });
    invoke.mockResolvedValueOnce({
      content: JSON.stringify(Object.fromEntries(batch2.map((_, i) => [String(i), "Billing And Refunds"]))),
    });

    await classifyRecordsWithLLM([...batch1, ...batch2]);

    expect(invoke).toHaveBeenCalledTimes(2);
    const secondCallPrompt = invoke.mock.calls[1][0][0].content;
    expect(secondCallPrompt).toContain("Billing And Refunds");
    expect(secondCallPrompt).toContain("Labels already used so far");
  });

  test("an empty record list makes no model calls", async () => {
    const result = await classifyRecordsWithLLM([]);
    expect(result).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });
});
