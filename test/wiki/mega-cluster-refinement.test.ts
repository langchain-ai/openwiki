import { beforeEach, describe, expect, test, vi } from "vitest";

// refineMegaClusters reuses classifyRecordsWithLLM under the hood — mock the
// same agent helpers content-classification.test.ts mocks, so this stays a
// fast, offline unit test of the size-threshold/re-clustering logic, not an
// integration test against a real provider.
const invoke = vi.fn();
vi.mock("../../src/agent/index.ts", () => ({
  createModel: () => ({ invoke }),
  resolveModelId: () => "fake-model",
}));
vi.mock("../../src/config/constants.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/constants.ts")>();
  return { ...actual, resolveConfiguredProvider: () => "anthropic" };
});

const { clusterByBestField } = await import("../../src/wiki/theme-extraction.ts");
const { refineMegaClusters } = await import("../../src/wiki/pipeline.ts");

function record(id: string, path: string) {
  const categoricalFields = new Map<string, string>([["path", path]]);
  return { categoricalFields, id, title: id, url: undefined };
}

describe("refineMegaClusters", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  test("leaves a normal-sized theme unchanged", async () => {
    const records = Array.from({ length: 10 }, (_, i) => record(`a${i}`, "oss"));
    const themes = clusterByBestField(
      [...records, ...Array.from({ length: 10 }, (_, i) => record(`b${i}`, "langgraph"))],
      { minRecords: 3 },
    );

    const refined = await refineMegaClusters(
      [...records, ...Array.from({ length: 10 }, (_, i) => record(`b${i}`, "langgraph"))],
      themes,
      3,
    );

    expect(refined).toEqual(themes);
    expect(invoke).not.toHaveBeenCalled();
  });

  test("splits an oversized theme into LLM-classified sub-themes", async () => {
    const megaRecords = Array.from({ length: 90 }, (_, i) => record(`ls${i}`, "langsmith"));
    // Several other real folders alongside the oversized one, so "langsmith"
    // doesn't dominate >70% of all categorized records (which would make
    // clusterByBestField reject the "path" field entirely, same as it would
    // for the real ~1200-file docs pull where langsmith is ~40% of the total).
    const otherRecords = ["oss", "langgraph", "langchain", "administration"].flatMap((folder) =>
      Array.from({ length: 10 }, (_, i) => record(`${folder}${i}`, folder)),
    );
    const records = [...megaRecords, ...otherRecords];
    const themes = clusterByBestField(records, { minRecords: 3 });
    expect(themes.find((t) => t.category === "langsmith")?.count).toBe(90);

    // First half classified as tracing, second half as admin — a genuine
    // sub-split the flat "langsmith" folder path alone couldn't reveal.
    invoke.mockResolvedValueOnce({
      content: JSON.stringify(
        Object.fromEntries(megaRecords.slice(0, 40).map((_, i) => [String(i), "Tracing"])),
      ),
    });
    invoke.mockResolvedValueOnce({
      content: JSON.stringify(
        Object.fromEntries(megaRecords.slice(40, 80).map((_, i) => [String(i), "Admin"])),
      ),
    });
    invoke.mockResolvedValueOnce({
      content: JSON.stringify(
        Object.fromEntries(megaRecords.slice(80, 90).map((_, i) => [String(i), "Admin"])),
      ),
    });

    const refined = await refineMegaClusters(records, themes, 3);

    const categories = refined.map((t) => t.category).sort();
    expect(categories).toContain("Tracing");
    expect(categories).toContain("Admin");
    expect(categories).not.toContain("langsmith");
    // The untouched "oss" theme survives alongside the refined sub-themes.
    expect(refined.some((t) => t.category === "oss")).toBe(true);
  });

  test("falls back to the original theme when the LLM can't usefully subdivide it", async () => {
    const megaRecords = Array.from({ length: 90 }, (_, i) => record(`ls${i}`, "langsmith"));
    const otherRecords = ["oss", "langgraph", "langchain", "administration"].flatMap((folder) =>
      Array.from({ length: 10 }, (_, i) => record(`${folder}${i}`, folder)),
    );
    const records = [...megaRecords, ...otherRecords];
    const themes = clusterByBestField(records, { minRecords: 3 });

    // Every record classified into the SAME single label -> only one
    // qualifying sub-category -> clusterByBestField can't produce >1 theme.
    invoke.mockResolvedValue({
      content: JSON.stringify(Object.fromEntries(megaRecords.slice(0, 40).map((_, i) => [String(i), "General"]))),
    });

    const refined = await refineMegaClusters(records, themes, 3);
    expect(refined.find((t) => t.category === "langsmith")?.count).toBe(90);
  });
});
