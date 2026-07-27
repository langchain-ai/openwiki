import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempHomes: string[] = [];

type HackerNewsDump = {
  feeds: { feed: string }[];
  queryResults: unknown[];
};

type ConnectorStateDump = {
  runs: {
    rawFiles: string[];
    runId: string;
    status: string;
    warnings: string[];
  }[];
};

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-hackernews-"));
  tempHomes.push(home);
  return home;
}

async function writeHackerNewsConfig(
  home: string,
  config: unknown,
): Promise<void> {
  const dir = path.join(home, ".openwiki", "connectors", "hackernews");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

function setConnectorTestHome(home: string): void {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
}

async function loadHackerNewsConnector(home: string) {
  vi.resetModules();
  setConnectorTestHome(home);
  const { createHackerNewsConnector } =
    await import("../src/connectors/sources/hackernews.ts");
  return createHackerNewsConnector();
}

function getRequestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

afterEach(async () => {
  vi.resetModules();
  vi.unstubAllGlobals();

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }

  await Promise.all(
    tempHomes
      .splice(0)
      .map((home) => rm(home, { force: true, recursive: true })),
  );
});

describe("hackernews connector feed configuration", () => {
  test("uses the default feeds when no feeds are configured", async () => {
    const home = await createTempHome();
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const requestPath = new URL(getRequestUrl(input)).pathname;
        paths.push(requestPath);

        if (requestPath === "/v0/topstories.json") {
          return Promise.resolve(jsonResponse([101]));
        }
        if (requestPath === "/v0/newstories.json") {
          return Promise.resolve(jsonResponse([202]));
        }
        if (requestPath === "/v0/item/101.json") {
          return Promise.resolve(
            jsonResponse({ id: 101, time: 1, title: "Top story" }),
          );
        }
        if (requestPath === "/v0/item/202.json") {
          return Promise.resolve(
            jsonResponse({ id: 202, time: 1, title: "New story" }),
          );
        }

        return Promise.resolve(jsonResponse({}));
      }),
    );
    const connector = await loadHackerNewsConnector(home);

    const result = await connector.ingest({ limit: 1 });

    expect(result.status).toBe("success");
    expect(result.warnings).toEqual([]);
    expect(paths).toEqual([
      "/v0/topstories.json",
      "/v0/item/101.json",
      "/v0/newstories.json",
      "/v0/item/202.json",
    ]);

    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as HackerNewsDump;
    expect(dump.feeds.map((feed) => feed.feed)).toEqual(["top", "new"]);
  });

  test("errors without writing raw results when configured feeds are invalid and there are no queries", async () => {
    const home = await createTempHome();
    await writeHackerNewsConfig(home, {
      enabled: true,
      feeds: ["frontpage", "popular"],
      queries: [],
    });
    const fetchMock = vi.fn(() => {
      throw new Error("fetch should not be called");
    });
    vi.stubGlobal("fetch", fetchMock);
    const connector = await loadHackerNewsConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("error");
    expect(result.rawFiles).toEqual([]);
    expect(result.message).toContain("No valid Hacker News feeds");
    expect(result.warnings).toEqual([
      "Ignored invalid Hacker News configured feed(s): frontpage, popular. Valid feeds are: ask, best, job, new, show, top.",
    ]);
    expect(fetchMock).not.toHaveBeenCalled();

    const statePath = path.join(
      home,
      ".openwiki",
      "connectors",
      "hackernews",
      "state.json",
    );
    const state = JSON.parse(
      await readFile(statePath, "utf8"),
    ) as ConnectorStateDump;
    expect(state.runs[0]).toMatchObject({
      rawFiles: [],
      runId: result.runId,
      status: "error",
      warnings: result.warnings,
    });
  });

  test("errors without writing raw results when requested feeds are invalid and there are no queries", async () => {
    const home = await createTempHome();
    const fetchMock = vi.fn(() => {
      throw new Error("fetch should not be called");
    });
    vi.stubGlobal("fetch", fetchMock);
    const connector = await loadHackerNewsConnector(home);

    const result = await connector.ingest({
      connectorConfig: { queries: [] },
      streams: ["frontpage"],
    });

    expect(result.status).toBe("error");
    expect(result.rawFiles).toEqual([]);
    expect(result.warnings).toEqual([
      "Ignored invalid Hacker News requested feed(s): frontpage. Valid feeds are: ask, best, job, new, show, top.",
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("preserves search failure warnings when invalid feeds leave query work", async () => {
    const home = await createTempHome();
    await writeHackerNewsConfig(home, {
      enabled: true,
      feeds: ["frontpage"],
      queries: ["openwiki"],
    });
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = getRequestUrl(input);
        urls.push(url);

        return Promise.resolve(
          new Response(JSON.stringify({ error: "unavailable" }), {
            headers: { "Content-Type": "application/json" },
            status: 503,
            statusText: "Service Unavailable",
          }),
        );
      }),
    );
    const connector = await loadHackerNewsConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(result.rawFiles).toHaveLength(1);
    expect(result.warnings).toEqual([
      "Ignored invalid Hacker News configured feed(s): frontpage. Valid feeds are: ask, best, job, new, show, top.",
      "openwiki: Hacker News search request failed: 503 Service Unavailable",
    ]);
    expect(urls.length).toBeGreaterThan(0);
    expect(
      urls.every((url) => new URL(url).pathname === "/api/v1/search_by_date"),
    ).toBe(true);

    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as HackerNewsDump;
    expect(dump.feeds).toEqual([]);
    expect(dump.queryResults).toEqual([]);
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}
