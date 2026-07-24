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
  loadLangSmithSetup,
  nextLangSmithApiKeyEnv,
  saveLangSmithSetup,
} from "../src/connectors/sources/langsmith/setup.ts";

const REPO = "/repo";
const EU = "https://eu.api.smith.langchain.com";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadLangSmithSetup", () => {
  test("maps workspaces to region + key env + project names", async () => {
    vi.mocked(readLangSmithRepoConfig).mockResolvedValue({
      workspaces: [
        {
          apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY",
          projects: [{ name: "a" }, { name: "b" }],
        },
        {
          apiBaseUrl: EU,
          apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY_2",
          projects: [{ name: "c" }],
        },
      ],
    });

    await expect(loadLangSmithSetup(REPO)).resolves.toEqual([
      {
        apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY",
        projects: ["a", "b"],
        region: "us",
      },
      {
        apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY_2",
        projects: ["c"],
        region: "eu",
      },
    ]);
  });

  test("returns an empty list when the repo has no config", async () => {
    vi.mocked(readLangSmithRepoConfig).mockResolvedValue(undefined);

    await expect(loadLangSmithSetup(REPO)).resolves.toEqual([]);
  });
});

describe("saveLangSmithSetup", () => {
  test("writes workspaces, US omitting apiBaseUrl and EU including it", async () => {
    vi.mocked(readLangSmithRepoConfig).mockResolvedValue(undefined);

    await saveLangSmithSetup(REPO, [
      {
        apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY",
        projects: ["a"],
        region: "us",
      },
      {
        apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY_2",
        projects: ["b"],
        region: "eu",
      },
    ]);

    expect(writeLangSmithRepoConfig).toHaveBeenCalledWith(REPO, {
      workspaces: [
        { apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY", projects: [{ name: "a" }] },
        {
          apiBaseUrl: EU,
          apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY_2",
          projects: [{ name: "b" }],
        },
      ],
    });
  });

  test("trims and dedupes project names, preserving order", async () => {
    vi.mocked(readLangSmithRepoConfig).mockResolvedValue(undefined);

    await saveLangSmithSetup(REPO, [
      {
        apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY",
        projects: ["  p ", "p", "q"],
        region: "us",
      },
    ]);

    expect(writeLangSmithRepoConfig).toHaveBeenCalledWith(REPO, {
      workspaces: [
        {
          apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY",
          projects: [{ name: "p" }, { name: "q" }],
        },
      ],
    });
  });

  test("drops a workspace with no projects (removal)", async () => {
    vi.mocked(readLangSmithRepoConfig).mockResolvedValue({
      workspaces: [
        {
          apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY",
          projects: [{ name: "old" }],
        },
      ],
    });

    await saveLangSmithSetup(REPO, [
      { apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY", projects: [], region: "us" },
      {
        apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY_2",
        projects: ["keep"],
        region: "us",
      },
    ]);

    expect(writeLangSmithRepoConfig).toHaveBeenCalledWith(REPO, {
      workspaces: [
        {
          apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY_2",
          projects: [{ name: "keep" }],
        },
      ],
    });
  });

  test("empties the file when all workspaces cleared but a config exists", async () => {
    vi.mocked(readLangSmithRepoConfig).mockResolvedValue({
      workspaces: [
        {
          apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY",
          projects: [{ name: "old" }],
        },
      ],
    });

    await saveLangSmithSetup(REPO, [
      { apiKeyEnv: "OPENWIKI_LANGSMITH_API_KEY", projects: [], region: "us" },
    ]);

    expect(writeLangSmithRepoConfig).toHaveBeenCalledWith(REPO, {
      workspaces: [],
    });
  });

  test("does not create a file when empty and none exists", async () => {
    vi.mocked(readLangSmithRepoConfig).mockResolvedValue(undefined);

    await saveLangSmithSetup(REPO, []);

    expect(writeLangSmithRepoConfig).not.toHaveBeenCalled();
  });
});

describe("nextLangSmithApiKeyEnv", () => {
  test("uses the base name when unused", () => {
    expect(nextLangSmithApiKeyEnv([])).toBe("OPENWIKI_LANGSMITH_API_KEY");
  });

  test("uses the first free numbered name when the base is taken", () => {
    expect(nextLangSmithApiKeyEnv(["OPENWIKI_LANGSMITH_API_KEY"])).toBe(
      "OPENWIKI_LANGSMITH_API_KEY_2",
    );
    expect(
      nextLangSmithApiKeyEnv([
        "OPENWIKI_LANGSMITH_API_KEY",
        "OPENWIKI_LANGSMITH_API_KEY_2",
      ]),
    ).toBe("OPENWIKI_LANGSMITH_API_KEY_3");
  });
});
