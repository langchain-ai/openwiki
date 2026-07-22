import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/connectors/sources/langsmith/repo-config.ts", () => ({
  readLangSmithRepoConfig: vi.fn(),
  writeLangSmithRepoConfig: vi.fn(() => Promise.resolve()),
}));

import {
  readLangSmithRepoConfig,
  writeLangSmithRepoConfig,
} from "../src/connectors/sources/langsmith/repo-config.ts";
import {
  listConfiguredLangSmithSources,
  setLangSmithProjects,
} from "../src/connectors/sources/langsmith/setup.ts";

const REPO = "/repo";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listConfiguredLangSmithSources", () => {
  test("returns the configured project names", async () => {
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

  test("empties the project list when cleared but a config exists", async () => {
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
