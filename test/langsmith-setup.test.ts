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
  listLangSmithProjectChoices,
  removeLangSmithSource,
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

describe("listLangSmithProjectChoices", () => {
  test("signals missing-key when no key is set", async () => {
    await expect(listLangSmithProjectChoices()).resolves.toEqual({
      ok: false,
      reason: "missing-key",
    });
    expect(createLangSmithApi).not.toHaveBeenCalled();
  });

  test("lists project names when a key is present", async () => {
    process.env[KEY] = "lsv2_test";
    vi.mocked(createLangSmithApi).mockReturnValue(
      fakeApi({
        listProjectNames: () => Promise.resolve(["prod", "staging"]),
      }),
    );

    await expect(listLangSmithProjectChoices()).resolves.toEqual({
      names: ["prod", "staging"],
      ok: true,
    });
  });

  test("falls back to LANGSMITH_API_KEY when the scoped var is unset", async () => {
    process.env.LANGSMITH_API_KEY = "lsv2_fallback";
    vi.mocked(createLangSmithApi).mockReturnValue(fakeApi());

    const result = await listLangSmithProjectChoices();

    expect(result.ok).toBe(true);
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
