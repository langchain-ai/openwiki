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
    await import("../../../src/connectors/sources/hackernews.ts");
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

describe("hackernews connector gating and limits", () => {
  test("skips without any fetch when the connector is disabled", async () => {
    const home = await createTempHome();
    await writeHackerNewsConfig(home, { enabled: false });
    const fetchMock = vi.fn(() => {
      throw new Error("fetch should not be called");
    });
    vi.stubGlobal("fetch", fetchMock);
    const connector = await loadHackerNewsConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("skipped");
    expect(result.message).toContain("not enabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("defaults the per-feed and per-query limits when config sets them null", async () => {
    const home = await createTempHome();
    // Null limits (malformed config) must fall back to the built-in maximum via
    // the `?? max` arm of getOptionLimit rather than become NaN.
    await writeHackerNewsConfig(home, {
      enabled: true,
      feeds: ["top"],
      maxItemsPerFeed: null,
      maxResultsPerQuery: null,
      queries: [],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const requestPath = new URL(getRequestUrl(input)).pathname;
        if (requestPath === "/v0/topstories.json") {
          return Promise.resolve(jsonResponse([10]));
        }
        if (requestPath === "/v0/item/10.json") {
          return Promise.resolve(jsonResponse({ id: 10, time: 1 }));
        }
        return Promise.resolve(jsonResponse({}));
      }),
    );
    const connector = await loadHackerNewsConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
  });
});

describe("hackernews feed and query resilience", () => {
  test("downgrades a feed fetch failure to a warning and still writes results", async () => {
    const home = await createTempHome();
    await writeHackerNewsConfig(home, {
      enabled: true,
      feeds: ["top"],
      queries: [],
    });
    // Every Firebase call returns a 500 so hnFirebaseApi throws; the per-feed
    // catch must record a warning instead of aborting the run.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response("nope", { status: 500, statusText: "Server Error" }),
        ),
      ),
    );
    const connector = await loadHackerNewsConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(result.rawFiles).toHaveLength(1);
    expect(
      result.warnings.some((warning) =>
        warning.includes("top: Hacker News API request failed: 500"),
      ),
    ).toBe(true);
    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as HackerNewsDump;
    expect(dump.feeds).toEqual([]);
  });

  test("applies the time window to feed items and to the search numeric filter", async () => {
    const home = await createTempHome();
    await writeHackerNewsConfig(home, {
      enabled: true,
      feeds: ["top"],
      maxItemsPerFeed: 5,
      queries: ["openwiki"],
      queryTags: ["story"],
    });
    const nowSec = Math.floor(Date.now() / 1000);
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = new URL(getRequestUrl(input));
        urls.push(url.toString());
        const requestPath = url.pathname;
        if (requestPath === "/v0/topstories.json") {
          return Promise.resolve(jsonResponse([1, 2, 3, 4]));
        }
        if (requestPath === "/v0/item/1.json") {
          // Fresh item: within the window, kept.
          return Promise.resolve(jsonResponse({ id: 1, time: nowSec }));
        }
        if (requestPath === "/v0/item/2.json") {
          // Old item: outside the window, dropped.
          return Promise.resolve(jsonResponse({ id: 2, time: 100 }));
        }
        if (requestPath === "/v0/item/3.json") {
          // A null item (deleted story) must be skipped by the `item &&` guard.
          return Promise.resolve(jsonResponse(null));
        }
        if (requestPath === "/v0/item/4.json") {
          // Missing `time` coerces to 0, which is outside any real window.
          return Promise.resolve(jsonResponse({ id: 4 }));
        }
        if (requestPath === "/api/v1/search_by_date") {
          return Promise.resolve(
            jsonResponse({ hits: [{ objectID: "h1" }], nbHits: 1, page: 0 }),
          );
        }
        return Promise.resolve(jsonResponse({}));
      }),
    );
    const connector = await loadHackerNewsConnector(home);

    const result = await connector.ingest({ windowHours: 24 });

    expect(result.status).toBe("success");
    const searchUrl = new URL(
      urls.find((url) => url.includes("search_by_date")) ?? "",
    );
    expect(searchUrl.searchParams.get("numericFilters")).toMatch(
      /^created_at_i>\d+$/u,
    );
    expect(searchUrl.searchParams.get("tags")).toBe("story");

    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as HackerNewsDump & {
      feeds: { items: { id: number }[] }[];
      windowHours: number | null;
    };
    // Only the fresh item survives the window filter.
    expect(dump.feeds[0]?.items.map((item) => item.id)).toEqual([1]);
    expect(dump.queryResults).toHaveLength(1);
    expect(dump.windowHours).toBe(24);
  });
});

describe("hackernews feed selection normalization", () => {
  test("falls back to the default feeds when configured feeds is an empty array", async () => {
    const home = await createTempHome();
    // An empty feeds array is treated as "unspecified", not "no feeds", so the
    // default top/new selection runs; a query keeps the run from erroring.
    await writeHackerNewsConfig(home, {
      enabled: true,
      feeds: [],
      maxItemsPerFeed: 1,
      queries: ["openwiki"],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const requestPath = new URL(getRequestUrl(input)).pathname;
        if (requestPath === "/v0/topstories.json") {
          return Promise.resolve(jsonResponse([10]));
        }
        if (requestPath === "/v0/newstories.json") {
          return Promise.resolve(jsonResponse([20]));
        }
        if (
          requestPath === "/v0/item/10.json" ||
          requestPath === "/v0/item/20.json"
        ) {
          return Promise.resolve(jsonResponse({ id: 10, time: 1 }));
        }
        if (requestPath === "/api/v1/search_by_date") {
          return Promise.resolve(jsonResponse({ hits: [], nbHits: 0 }));
        }
        return Promise.resolve(jsonResponse({}));
      }),
    );
    const connector = await loadHackerNewsConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(result.warnings).toEqual([]);
    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as HackerNewsDump;
    expect(dump.feeds.map((feed) => feed.feed)).toEqual(["top", "new"]);
  });

  test("warns about a non-array feeds config and runs no feeds", async () => {
    const home = await createTempHome();
    // A scalar `feeds` must be reported as a non-array and yield no feeds; the
    // query keeps the run alive so the warning is observable in a success run.
    await writeHackerNewsConfig(home, {
      enabled: true,
      feeds: "top",
      queries: ["openwiki"],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const requestPath = new URL(getRequestUrl(input)).pathname;
        if (requestPath === "/api/v1/search_by_date") {
          return Promise.resolve(jsonResponse({ hits: [], nbHits: 0 }));
        }
        return Promise.resolve(jsonResponse({}));
      }),
    );
    const connector = await loadHackerNewsConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(
      result.warnings.some(
        (warning) =>
          warning.includes("Ignored invalid Hacker News configured feed(s)") &&
          warning.includes("non-array string"),
      ),
    ).toBe(true);
    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as HackerNewsDump;
    expect(dump.feeds).toEqual([]);
  });

  test("warns about blank or non-string feed entries but keeps the valid ones", async () => {
    const home = await createTempHome();
    // A mixed array (valid feed plus a number and a blank string) must keep the
    // valid feed and report that some entries were dropped.
    await writeHackerNewsConfig(home, {
      enabled: true,
      feeds: ["top", 5, ""],
      maxItemsPerFeed: 1,
      queries: [],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const requestPath = new URL(getRequestUrl(input)).pathname;
        if (requestPath === "/v0/topstories.json") {
          return Promise.resolve(jsonResponse([10]));
        }
        if (requestPath === "/v0/item/10.json") {
          return Promise.resolve(jsonResponse({ id: 10, time: 1 }));
        }
        return Promise.resolve(jsonResponse({}));
      }),
    );
    const connector = await loadHackerNewsConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(
      result.warnings.some((warning) =>
        warning.includes("non-string or blank value"),
      ),
    ).toBe(true);
    const dump = JSON.parse(
      await readFile(result.rawFiles[0] ?? "", "utf8"),
    ) as HackerNewsDump;
    expect(dump.feeds.map((feed) => feed.feed)).toEqual(["top"]);
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}
