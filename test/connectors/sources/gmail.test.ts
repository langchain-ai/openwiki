import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

// The gmail connector's pure logic (query windowing/date-operator stripping,
// repeated label/header param construction, message-ref filtering, format
// normalization, and the 401 refresh-and-retry) is private and only observable
// by driving `ingest()` with a stubbed `fetch`. These tests point $HOME at a
// throwaway temp dir, feed controlled Gmail API responses, and assert on the
// exact request URLs and the raw dump written to disk. No real Gmail API call
// is made; the OAuth refresh in the 401 test is fully satisfied by the stub.

const originalEnv: Record<string, string | undefined> = {};
const TRACKED_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "OPENWIKI_GMAIL_ACCESS_TOKEN",
  "OPENWIKI_GMAIL_REFRESH_TOKEN",
  "OPENWIKI_GMAIL_TOKEN_EXPIRES_AT",
  "OPENWIKI_GMAIL_TOKEN_TYPE",
  "OPENWIKI_GOOGLE_CLIENT_ID",
  "OPENWIKI_GOOGLE_CLIENT_SECRET",
] as const;
const tempHomes: string[] = [];

for (const key of TRACKED_ENV_KEYS) {
  originalEnv[key] = process.env[key];
}

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-gmail-source-"));
  tempHomes.push(home);
  return home;
}

async function writeConnectorConfig(
  home: string,
  config: unknown,
): Promise<void> {
  const dir = path.join(home, ".openwiki", "connectors", "google");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

async function loadGmailConnector(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // A fresh, non-expiring token so getOAuthAccessToken short-circuits without
  // touching the OAuth refresh machinery at the start of the run.
  process.env.OPENWIKI_GMAIL_ACCESS_TOKEN = "gmail-access-token";
  process.env.OPENWIKI_GMAIL_REFRESH_TOKEN = "gmail-refresh-token";
  delete process.env.OPENWIKI_GMAIL_TOKEN_EXPIRES_AT;
  const { createGmailConnector } =
    await import("../../../src/connectors/sources/gmail.ts");
  return createGmailConnector();
}

function getRequestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

function getAuthorization(init: RequestInit | undefined): string {
  const headers = new Headers(init?.headers ?? {});
  return headers.get("authorization") ?? "";
}

interface GmailRequest {
  url: URL;
  authorization: string;
}

/**
 * Stubs global fetch and records each request URL + Authorization header. The
 * handler branches on the URL so tests can model the Gmail list/get endpoints
 * and (for the 401 case) the Google OAuth token endpoint. A numeric return is
 * treated as an HTTP status.
 */
function stubGmail(
  handler: (url: URL, request: GmailRequest) => unknown,
): GmailRequest[] {
  const requests: GmailRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(getRequestUrl(input));
      const request = { authorization: getAuthorization(init), url };
      requests.push(request);
      const body = handler(url, request);

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

interface GmailMessagesDump {
  format: string;
  maxMessages: number;
  messageCount: number;
  query: string;
  windowHours: number | null;
}

async function readMessagesDump(
  rawFiles: string[],
): Promise<GmailMessagesDump> {
  const file = rawFiles.find((entry) => entry.endsWith("gmail-messages.json"));
  expect(file).toBeDefined();
  return JSON.parse(
    await readFile(file as string, "utf8"),
  ) as GmailMessagesDump;
}

function isListRequest(url: URL): boolean {
  return url.pathname.endsWith("/messages");
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

describe("gmail connector gates", () => {
  test("skips when config is disabled", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, { enabled: false });
    const connector = await loadGmailConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("skipped");
  });

  test("accepts a legacy MCP placeholder config and warns", async () => {
    const home = await createTempHome();
    // A `transport` key marks the deprecated MCP config shape; the connector
    // must treat that as enabled and emit a migration warning.
    await writeConnectorConfig(home, { maxMessages: 1, transport: "stdio" });
    stubGmail(() => ({ messages: [] }));
    const connector = await loadGmailConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(
      result.warnings.some((warning) =>
        warning.includes("Ignoring legacy Gmail MCP placeholder config"),
      ),
    ).toBe(true);
  });
});

describe("gmail request construction", () => {
  test("skips message refs that have no id", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, { enabled: true, maxMessages: 10 });
    const requests = stubGmail((url) => {
      if (isListRequest(url)) {
        // The second ref lacks an id and must be skipped, not fetched.
        return { messages: [{ id: "m1" }, {}] };
      }
      return { id: "m1" };
    });
    const connector = await loadGmailConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    const messageGets = requests.filter(
      (request) => !isListRequest(request.url),
    );
    expect(messageGets).toHaveLength(1);
    expect(messageGets[0]?.url.pathname.endsWith("/messages/m1")).toBe(true);
    const dump = await readMessagesDump(result.rawFiles);
    expect(dump.messageCount).toBe(1);
  });

  test("sends configured labelIds as repeated query params", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, {
      enabled: true,
      labelIds: ["INBOX", "STARRED"],
      maxMessages: 1,
    });
    const requests = stubGmail(() => ({ messages: [] }));
    const connector = await loadGmailConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    const listRequest = requests.find((request) => isListRequest(request.url));
    expect(listRequest?.url.searchParams.getAll("labelIds")).toEqual([
      "INBOX",
      "STARRED",
    ]);
  });

  test("sends metadataHeaders as repeated params only for metadata format", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, {
      enabled: true,
      format: "metadata",
      maxMessages: 5,
      metadataHeaders: ["Subject", "From"],
    });
    const requests = stubGmail((url) => {
      if (isListRequest(url)) {
        return { messages: [{ id: "m1" }] };
      }
      return { id: "m1" };
    });
    const connector = await loadGmailConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    const messageGet = requests.find((request) => !isListRequest(request.url));
    expect(messageGet?.url.searchParams.get("format")).toBe("metadata");
    expect(messageGet?.url.searchParams.getAll("metadataHeaders")).toEqual([
      "Subject",
      "From",
    ]);
  });

  test("clamps a non-numeric maxMessages down to the minimum", async () => {
    const home = await createTempHome();
    // A malformed maxMessages must clamp to 1 rather than propagate NaN.
    await writeConnectorConfig(home, { enabled: true, maxMessages: "lots" });
    stubGmail(() => ({ messages: [] }));
    const connector = await loadGmailConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    const dump = await readMessagesDump(result.rawFiles);
    expect(dump.maxMessages).toBe(1);
  });
});

describe("gmail query windowing", () => {
  // getWindowedGmailQuery must strip any existing date operator from the base
  // query and append a single newer_than window derived from windowHours
  // (rounded up to whole days), leaving non-date operators intact.
  test.each([
    ["in:inbox newer_than:7d", 48, "in:inbox newer_than:2d"],
    ["newer_than:5d", 24, "newer_than:1d"],
    ["from:me older_than:3d", 24, "from:me newer_than:1d"],
  ])(
    "rewrites query %s with a %ih window",
    async (query, windowHours, expectedQuery) => {
      const home = await createTempHome();
      await writeConnectorConfig(home, {
        enabled: true,
        maxMessages: 1,
        query,
      });
      const requests = stubGmail(() => ({ messages: [] }));
      const connector = await loadGmailConnector(home);

      const result = await connector.ingest({ windowHours });

      expect(result.status).toBe("success");
      const listRequest = requests.find((request) =>
        isListRequest(request.url),
      );
      expect(listRequest?.url.searchParams.get("q")).toBe(expectedQuery);
    },
  );

  test("throws when the Gmail API returns a non-ok status", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, { enabled: true, maxMessages: 1 });
    stubGmail(() => 500);
    const connector = await loadGmailConnector(home);

    await expect(connector.ingest()).rejects.toThrow(
      "Gmail API request failed: 500",
    );
  });

  test("falls back to the default query when the configured query is blank", async () => {
    const home = await createTempHome();
    // An empty query must normalize to the "newer_than:1d" default rather than
    // send an empty `q` (which Gmail would reject); windowHours is absent so the
    // base query passes through getWindowedGmailQuery unmodified.
    await writeConnectorConfig(home, {
      enabled: true,
      maxMessages: 1,
      query: "",
    });
    const requests = stubGmail(() => ({ messages: [] }));
    const connector = await loadGmailConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    const listRequest = requests.find((request) => isListRequest(request.url));
    expect(listRequest?.url.searchParams.get("q")).toBe("newer_than:1d");
  });
});

describe("gmail response normalization edge cases", () => {
  test("follows nextPageToken and tolerates a page missing its messages array", async () => {
    const home = await createTempHome();
    // maxMessages exceeds a single page's yield so the connector must page a
    // second time. The second page omits `messages` entirely: an untrusted
    // payload shape that must coerce to an empty list, not throw.
    await writeConnectorConfig(home, {
      enabled: true,
      maxMessages: 5,
      pageSize: 2,
    });
    const requests = stubGmail((url) => {
      if (isListRequest(url)) {
        if (url.searchParams.get("pageToken") === "PAGE2") {
          return {};
        }
        return { messages: [{ id: "m1" }], nextPageToken: "PAGE2" };
      }
      return { id: "m1" };
    });
    const connector = await loadGmailConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    const listRequests = requests.filter((request) =>
      isListRequest(request.url),
    );
    expect(listRequests).toHaveLength(2);
    // The second list page must carry the token returned by the first.
    expect(listRequests[1]?.url.searchParams.get("pageToken")).toBe("PAGE2");
    const dump = await readMessagesDump(result.rawFiles);
    expect(dump.messageCount).toBe(1);
  });

  test("normalizes an unknown message format to full", async () => {
    const home = await createTempHome();
    // A null format (malformed on-disk config) must fall back to "full" rather
    // than propagate an invalid value into the message-get request.
    await writeConnectorConfig(home, {
      enabled: true,
      format: null,
      maxMessages: 1,
    });
    stubGmail(() => ({ messages: [] }));
    const connector = await loadGmailConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    const dump = await readMessagesDump(result.rawFiles);
    expect(dump.format).toBe("full");
  });
});

describe("gmail 401 refresh retry", () => {
  test("refreshes the access token and retries the request once", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, { enabled: true, maxMessages: 1 });
    // The mid-flight refresh needs a client id/secret to build the token POST.
    process.env.OPENWIKI_GOOGLE_CLIENT_ID = "google-client-id";
    process.env.OPENWIKI_GOOGLE_CLIENT_SECRET = "google-client-secret";
    let listAttempts = 0;
    const requests = stubGmail((url) => {
      if (url.host === "oauth2.googleapis.com") {
        // The refresh grant returns a new access token used on the retry.
        return {
          access_token: "refreshed-token",
          expires_in: 3600,
          refresh_token: "gmail-refresh-token",
          token_type: "Bearer",
        };
      }
      if (isListRequest(url)) {
        listAttempts += 1;
        // First attempt is a 401; the connector must refresh and retry.
        return listAttempts === 1 ? 401 : { messages: [] };
      }
      return { id: "m1" };
    });
    const connector = await loadGmailConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(listAttempts).toBe(2);
    // A token exchange must have occurred against the Google token endpoint.
    expect(
      requests.some((request) => request.url.host === "oauth2.googleapis.com"),
    ).toBe(true);
    // The retried list request must carry the refreshed bearer token.
    const listRequests = requests.filter((request) =>
      isListRequest(request.url),
    );
    expect(listRequests[1]?.authorization).toBe("Bearer refreshed-token");
  });
});
