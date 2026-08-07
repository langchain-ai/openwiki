import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OPENWIKI_TAVILY_API_KEY_ENV_KEY } from "../../../src/config/constants.ts";

// Tavily is the one network boundary; the constructor options and per-query
// invoke calls are captured so we can assert query building without hitting the
// network. The io layer stays real (temp HOME) so we read back the raw dump.
const tavily = vi.hoisted(() => {
  const invoke = vi.fn(() =>
    Promise.resolve({ answer: "an answer", results: [{ title: "hit" }] }),
  );
  const constructed: Record<string, unknown>[] = [];
  const TavilySearch = vi.fn(function (
    this: Record<string, unknown>,
    options: Record<string, unknown>,
  ) {
    constructed.push(options);
    this.invoke = invoke;
  });
  return { TavilySearch, constructed, invoke };
});
vi.mock("@langchain/tavily", () => ({ TavilySearch: tavily.TavilySearch }));

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalApiKey = process.env[OPENWIKI_TAVILY_API_KEY_ENV_KEY];
const tempHomes: string[] = [];

type WebSearchDump = {
  maxResults: number;
  queryCount: number;
  results: { query: string; response: unknown }[];
  searchDepth: string;
  timeRange?: string;
  topic: string;
};

type ConnectorStateDump = {
  runs: { rawFiles: string[]; runId: string; status: string }[];
};

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-web-search-"));
  tempHomes.push(home);
  return home;
}

async function writeWebSearchConfig(
  home: string,
  config: unknown,
): Promise<void> {
  const dir = path.join(home, ".openwiki", "connectors", "web-search");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

async function loadWebSearchConnector(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const { createWebSearchConnector } =
    await import("../../../src/connectors/sources/web-search.ts");
  return createWebSearchConnector();
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

beforeEach(() => {
  tavily.constructed.splice(0);
  tavily.invoke.mockClear();
  tavily.invoke.mockResolvedValue({
    answer: "an answer",
    results: [{ title: "hit" }],
  });
});

afterEach(async () => {
  vi.resetModules();
  restoreEnv("HOME", originalHome);
  restoreEnv("USERPROFILE", originalUserProfile);
  restoreEnv(OPENWIKI_TAVILY_API_KEY_ENV_KEY, originalApiKey);

  await Promise.all(
    tempHomes
      .splice(0)
      .map((home) => rm(home, { force: true, recursive: true })),
  );
});

describe("web-search connector gating", () => {
  test("skips when the connector is disabled", async () => {
    const home = await createTempHome();
    await writeWebSearchConfig(home, { enabled: false, queries: ["x"] });
    process.env[OPENWIKI_TAVILY_API_KEY_ENV_KEY] = "tvly-key";
    const connector = await loadWebSearchConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("skipped");
    expect(result.message).toContain("not enabled");
    expect(tavily.TavilySearch).not.toHaveBeenCalled();
  });

  test("errors when the Tavily API key is missing", async () => {
    const home = await createTempHome();
    await writeWebSearchConfig(home, { enabled: true, queries: ["x"] });
    delete process.env[OPENWIKI_TAVILY_API_KEY_ENV_KEY];
    const connector = await loadWebSearchConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("error");
    expect(result.message).toContain(OPENWIKI_TAVILY_API_KEY_ENV_KEY);
    expect(tavily.TavilySearch).not.toHaveBeenCalled();
  });

  test("skips when no queries are configured", async () => {
    const home = await createTempHome();
    await writeWebSearchConfig(home, { enabled: true, queries: [] });
    process.env[OPENWIKI_TAVILY_API_KEY_ENV_KEY] = "tvly-key";
    const connector = await loadWebSearchConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("skipped");
    expect(result.message).toContain("No web search queries");
    expect(tavily.TavilySearch).not.toHaveBeenCalled();
  });
});

describe("web-search connector query execution", () => {
  test("builds the Tavily tool from config and invokes it per query", async () => {
    const home = await createTempHome();
    await writeWebSearchConfig(home, {
      enabled: true,
      maxResults: 3,
      queries: ["openwiki", "langchain"],
      searchDepth: "advanced",
      topic: "news",
    });
    process.env[OPENWIKI_TAVILY_API_KEY_ENV_KEY] = "tvly-key";
    const connector = await loadWebSearchConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(result.message).toBe(
      "Fetched Tavily results for 2 web search queries.",
    );

    expect(tavily.TavilySearch).toHaveBeenCalledTimes(1);
    expect(tavily.constructed[0]).toMatchObject({
      includeAnswer: true,
      maxResults: 3,
      searchDepth: "advanced",
      tavilyApiKey: "tvly-key",
      topic: "news",
    });
    expect(tavily.invoke.mock.calls).toEqual([
      [{ query: "openwiki" }],
      [{ query: "langchain" }],
    ]);

    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as WebSearchDump;
    expect(dump.queryCount).toBe(2);
    expect(dump.maxResults).toBe(3);
    expect(dump.searchDepth).toBe("advanced");
    expect(dump.topic).toBe("news");
    expect(dump.results.map((entry) => entry.query)).toEqual([
      "openwiki",
      "langchain",
    ]);
    expect(dump.results[0]?.response).toEqual({
      answer: "an answer",
      results: [{ title: "hit" }],
    });

    const statePath = path.join(
      home,
      ".openwiki",
      "connectors",
      "web-search",
      "state.json",
    );
    const state = JSON.parse(
      await readFile(statePath, "utf8"),
    ) as ConnectorStateDump;
    expect(state.runs[0]).toMatchObject({
      runId: result.runId,
      status: "success",
    });
  });

  test("clamps the result limit and prefers the option limit over config", async () => {
    const home = await createTempHome();
    await writeWebSearchConfig(home, {
      enabled: true,
      maxResults: 50,
      queries: ["openwiki"],
    });
    process.env[OPENWIKI_TAVILY_API_KEY_ENV_KEY] = "tvly-key";
    const connector = await loadWebSearchConnector(home);

    const result = await connector.ingest({ limit: 100 });

    expect(result.status).toBe("success");
    expect(result.message).toBe(
      "Fetched Tavily results for 1 web search query.",
    );
    // getOptionLimit clamps to a maximum of 20.
    expect(tavily.constructed[0]?.maxResults).toBe(20);
  });

  test("uses a configured time range verbatim and ignores the window", async () => {
    const home = await createTempHome();
    // An explicit, valid timeRange must win over any window-derived range.
    await writeWebSearchConfig(home, {
      enabled: true,
      queries: ["openwiki"],
      timeRange: "week",
    });
    process.env[OPENWIKI_TAVILY_API_KEY_ENV_KEY] = "tvly-key";
    const connector = await loadWebSearchConnector(home);

    const result = await connector.ingest({ windowHours: 6 });

    expect(result.status).toBe("success");
    expect(tavily.constructed[0]?.timeRange).toBe("week");

    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as WebSearchDump;
    expect(dump.timeRange).toBe("week");
  });

  test("normalizes null include flags and result limit to their defaults", async () => {
    const home = await createTempHome();
    // Null-valued flags and limit (malformed config) must coerce to the coded
    // defaults rather than reach the Tavily client as null.
    await writeWebSearchConfig(home, {
      enabled: true,
      includeAnswer: null,
      includeImages: null,
      includeRawContent: null,
      maxResults: null,
      queries: ["openwiki"],
    });
    process.env[OPENWIKI_TAVILY_API_KEY_ENV_KEY] = "tvly-key";
    const connector = await loadWebSearchConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(tavily.constructed[0]).toMatchObject({
      includeAnswer: true,
      includeImages: false,
      includeRawContent: false,
      maxResults: 5,
    });
  });

  test("derives a day time range from a short window when none is configured", async () => {
    const home = await createTempHome();
    await writeWebSearchConfig(home, { enabled: true, queries: ["openwiki"] });
    process.env[OPENWIKI_TAVILY_API_KEY_ENV_KEY] = "tvly-key";
    const connector = await loadWebSearchConnector(home);

    const result = await connector.ingest({ windowHours: 6 });

    expect(result.status).toBe("success");
    expect(tavily.constructed[0]?.timeRange).toBe("day");

    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as WebSearchDump;
    expect(dump.timeRange).toBe("day");
  });
});
