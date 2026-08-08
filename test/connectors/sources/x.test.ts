import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

// The x connector's pure logic (stream/URL construction, pagination-token
// following, since_id carry-over from state, and window start_time derivation)
// is private and only observable by driving `ingest()` with a stubbed `fetch`.
// These tests point $HOME at a throwaway temp dir so the connector reads a
// controlled on-disk config/state, then assert on the exact request URLs the
// connector builds and on the raw dump / state it writes back. No real X API
// call or OAuth token is involved.

const originalEnv: Record<string, string | undefined> = {};
const TRACKED_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "OPENWIKI_X_ACCESS_TOKEN",
  "OPENWIKI_X_CLIENT_ID",
  "OPENWIKI_X_REFRESH_TOKEN",
  "OPENWIKI_X_TOKEN_EXPIRES_AT",
  "OPENWIKI_X_TOKEN_TYPE",
] as const;
const tempHomes: string[] = [];

for (const key of TRACKED_ENV_KEYS) {
  originalEnv[key] = process.env[key];
}

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-x-source-"));
  tempHomes.push(home);
  return home;
}

async function writeConnectorConfig(
  home: string,
  config: unknown,
): Promise<void> {
  const dir = path.join(home, ".openwiki", "connectors", "x");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

async function writeConnectorState(
  home: string,
  state: unknown,
): Promise<void> {
  const dir = path.join(home, ".openwiki", "connectors", "x");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
}

async function readConnectorState(home: string): Promise<{
  latestIds?: Record<string, string>;
}> {
  const raw = await readFile(
    path.join(home, ".openwiki", "connectors", "x", "state.json"),
    "utf8",
  );
  return JSON.parse(raw) as { latestIds?: Record<string, string> };
}

async function loadXConnector(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // A fresh, non-expiring token so getOAuthAccessToken short-circuits without
  // touching the OAuth refresh machinery.
  process.env.OPENWIKI_X_ACCESS_TOKEN = "x-access-token";
  delete process.env.OPENWIKI_X_TOKEN_EXPIRES_AT;
  const { createXConnector } =
    await import("../../../src/connectors/sources/x.ts");
  return createXConnector();
}

function getRequestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

/**
 * Stubs global fetch with a handler keyed on the request URL pathname and
 * records every requested URL so tests can assert on the built query strings.
 */
function stubFetchByPath(
  handler: (pathname: string, url: URL) => unknown,
): URL[] {
  const requests: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request) => {
      const url = new URL(getRequestUrl(input));
      requests.push(url);
      const body = handler(url.pathname, url);

      if (typeof body === "number") {
        return Promise.resolve(new Response("{}", { status: body }));
      }

      return Promise.resolve(
        new Response(JSON.stringify(body), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      );
    }),
  );
  return requests;
}

afterEach(async () => {
  vi.resetModules();
  vi.unstubAllGlobals();

  for (const key of TRACKED_ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }

  await Promise.all(
    tempHomes
      .splice(0)
      .map((home) => rm(home, { force: true, recursive: true })),
  );
});

describe("x connector authenticated-user resolution", () => {
  test("resolves the user id from /2/users/me when config omits userId", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, {
      enabled: true,
      maxPagesPerStream: 1,
      streams: ["user_posts"],
    });
    const requests = stubFetchByPath((pathname) => {
      if (pathname === "/2/users/me") {
        return { data: { id: "U777" } };
      }
      return { data: [{ id: "t1" }], meta: {} };
    });
    const connector = await loadXConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    // The id from /2/users/me must flow into the per-user stream path.
    expect(requests.map((url) => url.pathname)).toEqual([
      "/2/users/me",
      "/2/users/U777/tweets",
    ]);
  });

  // getNestedString must reject every shape that is not a plain object chain
  // ending in a string, otherwise a malformed /users/me payload would silently
  // yield an empty user id and build a `/users//tweets` request.
  test.each([
    ["data key missing", {}],
    ["data is null", { data: null }],
    ["id key missing", { data: {} }],
    ["id is not a string", { data: { id: 5 } }],
  ])("throws when /2/users/me payload has %s", async (_label, payload) => {
    const home = await createTempHome();
    await writeConnectorConfig(home, {
      enabled: true,
      streams: ["user_posts"],
    });
    stubFetchByPath((pathname) => (pathname === "/2/users/me" ? payload : {}));
    const connector = await loadXConnector(home);

    await expect(connector.ingest()).rejects.toThrow(
      "Could not resolve authenticated X user ID",
    );
  });
});

describe("x connector gates", () => {
  test("skips when config is disabled", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, { enabled: false });
    const connector = await loadXConnector(home);
    delete process.env.OPENWIKI_X_ACCESS_TOKEN;

    const result = await connector.ingest();

    expect(result.status).toBe("skipped");
  });

  test("errors when the access token env is unset", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, { enabled: true });
    const connector = await loadXConnector(home);
    delete process.env.OPENWIKI_X_ACCESS_TOKEN;

    const result = await connector.ingest();

    expect(result.status).toBe("error");
    expect(result.message).toContain("OPENWIKI_X_ACCESS_TOKEN");
  });
});

describe("x connector request construction", () => {
  test("builds the per-stream path for every non-list stream", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, {
      enabled: true,
      maxPagesPerStream: 1,
      streams: ["home_timeline", "mentions", "bookmarks"],
      userId: "U1",
    });
    const requests = stubFetchByPath(() => ({ data: [], meta: {} }));
    const connector = await loadXConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    // getStreamPath must map each stream keyword to its X API v2 endpoint.
    expect(requests.map((url) => url.pathname)).toEqual([
      "/2/users/U1/timelines/reverse_chronological",
      "/2/users/U1/mentions",
      "/2/users/U1/bookmarks",
    ]);
    // bookmarks intentionally omits since_id/start_time (see ingest branch).
    const bookmarks = requests.find((url) =>
      url.pathname.endsWith("/bookmarks"),
    );
    expect(bookmarks?.searchParams.get("start_time")).toBeNull();
  });

  test("throws when a stream request returns a non-ok status", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, {
      enabled: true,
      maxPagesPerStream: 1,
      streams: ["user_posts"],
      userId: "U1",
    });
    stubFetchByPath(() => 500);
    const connector = await loadXConnector(home);

    await expect(connector.ingest()).rejects.toThrow(
      "X API request failed: 500",
    );
  });

  test("paginates each configured list and carries newest id into state", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, {
      enabled: true,
      listIds: ["L1"],
      maxPagesPerStream: 2,
      streams: ["list_posts"],
      userId: "U1",
    });
    // A prior run's newest id must be sent as since_id on the first page.
    await writeConnectorState(home, {
      latestIds: { "list_posts:L1": "prev-id" },
      version: 1,
    });
    const requests = stubFetchByPath((_pathname, url) => {
      if (url.searchParams.get("pagination_token")) {
        // Second page: no next_token stops the loop before maxPages is hit.
        return { data: [{ id: "b" }], meta: { result_count: 1 } };
      }
      return {
        data: [{ id: "a" }],
        meta: { newest_id: "n1", next_token: "NT" },
      };
    });
    const connector = await loadXConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    const listRequests = requests.filter((url) =>
      url.pathname.startsWith("/2/lists/"),
    );
    expect(listRequests).toHaveLength(2);
    expect(listRequests[0]?.pathname).toBe("/2/lists/L1/tweets");
    // First page forwards the stored since_id and no pagination token.
    expect(listRequests[0]?.searchParams.get("since_id")).toBe("prev-id");
    expect(listRequests[0]?.searchParams.get("pagination_token")).toBeNull();
    // Second page follows the returned next_token.
    expect(listRequests[1]?.searchParams.get("pagination_token")).toBe("NT");

    // The newest id from the first page must be persisted for the next run.
    const state = await readConnectorState(home);
    expect(state.latestIds?.["list_posts:L1"]).toBe("n1");

    const listFile = result.rawFiles.find((file) =>
      file.endsWith("list-L1.json"),
    );
    expect(listFile).toBeDefined();
    const dump = JSON.parse(await readFile(listFile as string, "utf8")) as {
      pages: unknown[];
    };
    expect(dump.pages).toHaveLength(2);
  });

  test("prefers explicitly requested streams over the configured streams", async () => {
    const home = await createTempHome();
    // options.streams (a non-empty array) must override config.streams so a
    // caller can scope a run to a single stream.
    await writeConnectorConfig(home, {
      enabled: true,
      maxPagesPerStream: 1,
      streams: ["mentions"],
      userId: "U1",
    });
    const requests = stubFetchByPath(() => ({ data: [], meta: {} }));
    const connector = await loadXConnector(home);

    const result = await connector.ingest({ streams: ["user_posts"] });

    expect(result.status).toBe("success");
    expect(requests.map((url) => url.pathname)).toEqual(["/2/users/U1/tweets"]);
  });

  test("skips writing when a list_posts stream has no configured list ids", async () => {
    const home = await createTempHome();
    // With only list_posts selected and no list ids, the stream loop produces
    // no raw files, so the run reports "skipped" and issues no request.
    await writeConnectorConfig(home, {
      enabled: true,
      listIds: [],
      maxPagesPerStream: 1,
      streams: ["list_posts"],
      userId: "U1",
    });
    const requests = stubFetchByPath(() => ({ data: [], meta: {} }));
    const connector = await loadXConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("skipped");
    expect(result.rawFiles).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  test("keeps the prior since_id when a list page returns no newest_id", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, {
      enabled: true,
      listIds: ["L1"],
      maxPagesPerStream: 1,
      streams: ["list_posts"],
      userId: "U1",
    });
    // A prior cursor exists; a page with no newest_id must leave it untouched
    // rather than clobber the persisted position.
    await writeConnectorState(home, {
      latestIds: { "list_posts:L1": "prev" },
      version: 1,
    });
    stubFetchByPath(() => ({ data: [{ id: "a" }], meta: { result_count: 1 } }));
    const connector = await loadXConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    const state = await readConnectorState(home);
    expect(state.latestIds?.["list_posts:L1"]).toBe("prev");
  });

  test("records an empty cursor when a list has no prior id and no newest_id", async () => {
    const home = await createTempHome();
    // No prior state and a page without newest_id must resolve the cursor to the
    // empty-string fallback, which is then pruned from persisted state.
    await writeConnectorConfig(home, {
      enabled: true,
      listIds: ["L1"],
      maxPagesPerStream: 1,
      streams: ["list_posts"],
      userId: "U1",
    });
    stubFetchByPath(() => ({ data: [{ id: "a" }], meta: { result_count: 1 } }));
    const connector = await loadXConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    const state = await readConnectorState(home);
    // The empty cursor is stripped by removeEmptyValues, so the key is absent.
    expect(state.latestIds?.["list_posts:L1"]).toBeUndefined();
  });

  test("adds a window start_time derived from windowHours", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, {
      enabled: true,
      maxPagesPerStream: 1,
      streams: ["user_posts"],
      userId: "U1",
    });
    const requests = stubFetchByPath(() => ({ data: [], meta: {} }));
    const connector = await loadXConnector(home);

    const before = Date.now();
    const result = await connector.ingest({ windowHours: 24 });

    expect(result.status).toBe("success");
    const startTime = requests[0]?.searchParams.get("start_time");
    expect(startTime).toBeTruthy();
    const startMs = Date.parse(startTime as string);
    // 24h window => start_time is ~24h before now, and a valid ISO instant.
    expect(Number.isFinite(startMs)).toBe(true);
    expect(startMs).toBeLessThanOrEqual(before);
    expect(startMs).toBeGreaterThan(before - 25 * 60 * 60 * 1000);

    const dump = JSON.parse(await readFile(result.rawFiles[0], "utf8")) as {
      windowHours: number | null;
    };
    expect(dump.windowHours).toBe(24);
  });
});
