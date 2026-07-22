import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/connectors/sources/langsmith/api.ts", () => ({
  createLangSmithApi: vi.fn(),
}));

// Keep the real pure helpers (withProject/withoutProject) and mock only the I/O.
vi.mock(
  "../src/connectors/sources/langsmith/repo-config.ts",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../src/connectors/sources/langsmith/repo-config.ts")
    >()),
    readLangSmithRepoConfig: vi.fn(),
    writeLangSmithRepoConfig: vi.fn(() => Promise.resolve()),
  }),
);

import { createLangSmithApi } from "../src/connectors/sources/langsmith/api.ts";
import type { LangSmithApi } from "../src/connectors/sources/langsmith/api.ts";
import {
  readLangSmithRepoConfig,
  writeLangSmithRepoConfig,
} from "../src/connectors/sources/langsmith/repo-config.ts";
import {
  addLangSmithSource,
  listConfiguredLangSmithSources,
  removeLangSmithSource,
  searchLangSmithProjects,
  setLangSmithProjects,
} from "../src/connectors/sources/langsmith/setup.ts";

const KEY = "OPENWIKI_LANGSMITH_API_KEY";
const REPO = "/repo";
const saved: Record<string, string | undefined> = {};

function fakeApi(overrides: Partial<LangSmithApi> = {}): LangSmithApi {
  return {
    fetchFeedback: () => Promise.resolve([]),
    fetchTrace: () => Promise.resolve([]),
    listProjectNames: () => Promise.resolve([]),
    listRecentRootRuns: () => Promise.resolve([]),
    resolveProject: () => Promise.resolve({ id: "p", url: "u" }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  saved[KEY] = process.env[KEY];
  saved.LANGSMITH_API_KEY = process.env.LANGSMITH_API_KEY;
  delete process.env[KEY];
  delete process.env.LANGSMITH_API_KEY;
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("searchLangSmithProjects", () => {
  test("returns [] for a blank query without calling the API", async () => {
    process.env[KEY] = "lsv2_test";

    await expect(searchLangSmithProjects("   ")).resolves.toEqual([]);
    expect(createLangSmithApi).not.toHaveBeenCalled();
  });

  test("returns [] when no key is available", async () => {
    await expect(searchLangSmithProjects("prod")).resolves.toEqual([]);
    expect(createLangSmithApi).not.toHaveBeenCalled();
  });

  test("searches server-side by the trimmed name substring, capped at 50", async () => {
    process.env[KEY] = "lsv2_test";
    const listProjectNames = vi.fn(
      (options: { limit?: number; nameContains?: string } = {}) =>
        Promise.resolve(options.nameContains ? ["prod-1", "prod-2"] : []),
    );
    vi.mocked(createLangSmithApi).mockReturnValue(
      fakeApi({ listProjectNames }),
    );

    await expect(searchLangSmithProjects("  prod  ")).resolves.toEqual([
      "prod-1",
      "prod-2",
    ]);
    expect(listProjectNames).toHaveBeenCalledWith({
      limit: 50,
      nameContains: "prod",
    });
  });

  test("falls back to LANGSMITH_API_KEY when the scoped var is unset", async () => {
    process.env.LANGSMITH_API_KEY = "lsv2_fallback";
    vi.mocked(createLangSmithApi).mockReturnValue(fakeApi());

    await searchLangSmithProjects("prod");

    expect(createLangSmithApi).toHaveBeenCalledTimes(1);
  });
});

describe("listConfiguredLangSmithSources", () => {
  test("returns configured project names", async () => {
    vi.mocked(readLangSmithRepoConfig).mockResolvedValue({
      projects: [{ name: "a" }, { name: "b" }],
    });

    await expect(listConfiguredLangSmithSources(REPO)).resolves.toEqual([
      "a",
      "b",
    ]);
  });

  test("returns an empty list when the repo has no config", async () => {
    vi.mocked(readLangSmithRepoConfig).mockResolvedValue(undefined);

    await expect(listConfiguredLangSmithSources(REPO)).resolves.toEqual([]);
  });
});

describe("addLangSmithSource", () => {
  test("adds a project to the committed config", async () => {
    vi.mocked(readLangSmithRepoConfig).mockResolvedValue({
      projects: [{ name: "a" }],
    });

    await addLangSmithSource(REPO, "b");

    expect(writeLangSmithRepoConfig).toHaveBeenCalledWith(REPO, {
      projects: [{ name: "a" }, { name: "b" }],
    });
  });

  test("seeds a fresh config when none exists", async () => {
    vi.mocked(readLangSmithRepoConfig).mockResolvedValue(undefined);

    await addLangSmithSource(REPO, "prod");

    expect(writeLangSmithRepoConfig).toHaveBeenCalledWith(REPO, {
      projects: [{ name: "prod" }],
    });
  });

  test("is idempotent — a duplicate name does not double-write", async () => {
    vi.mocked(readLangSmithRepoConfig).mockResolvedValue({
      projects: [{ name: "prod" }],
    });

    await addLangSmithSource(REPO, "prod");

    expect(writeLangSmithRepoConfig).toHaveBeenCalledWith(REPO, {
      projects: [{ name: "prod" }],
    });
  });
});

describe("setLangSmithProjects", () => {
  test("writes exactly the given projects, preserving other fields", async () => {
    vi.mocked(readLangSmithRepoConfig).mockResolvedValue({
      apiBaseUrl: "https://eu.api.smith.langchain.com",
      includeFeedback: true,
      projects: [{ name: "old" }],
    });

    await setLangSmithProjects(REPO, ["a", "b"]);

    expect(writeLangSmithRepoConfig).toHaveBeenCalledWith(REPO, {
      apiBaseUrl: "https://eu.api.smith.langchain.com",
      includeFeedback: true,
      projects: [{ name: "a" }, { name: "b" }],
    });
  });

  test("trims and dedupes, preserving order", async () => {
    vi.mocked(readLangSmithRepoConfig).mockResolvedValue(undefined);

    await setLangSmithProjects(REPO, ["  prod  ", "prod", "staging"]);

    expect(writeLangSmithRepoConfig).toHaveBeenCalledWith(REPO, {
      projects: [{ name: "prod" }, { name: "staging" }],
    });
  });

  test("empties the project list when the selection is cleared but a config exists", async () => {
    vi.mocked(readLangSmithRepoConfig).mockResolvedValue({
      projects: [{ name: "old" }],
    });

    await setLangSmithProjects(REPO, []);

    expect(writeLangSmithRepoConfig).toHaveBeenCalledWith(REPO, {
      projects: [],
    });
  });

  test("does not create a file when the selection is empty and none exists", async () => {
    vi.mocked(readLangSmithRepoConfig).mockResolvedValue(undefined);

    await setLangSmithProjects(REPO, []);

    expect(writeLangSmithRepoConfig).not.toHaveBeenCalled();
  });
});

describe("removeLangSmithSource", () => {
  test("removes a project from the committed config", async () => {
    vi.mocked(readLangSmithRepoConfig).mockResolvedValue({
      projects: [{ name: "a" }, { name: "b" }],
    });

    await removeLangSmithSource(REPO, "a");

    expect(writeLangSmithRepoConfig).toHaveBeenCalledWith(REPO, {
      projects: [{ name: "b" }],
    });
  });

  test("does nothing when there is no config", async () => {
    vi.mocked(readLangSmithRepoConfig).mockResolvedValue(undefined);

    await removeLangSmithSource(REPO, "a");

    expect(writeLangSmithRepoConfig).not.toHaveBeenCalled();
  });
});
