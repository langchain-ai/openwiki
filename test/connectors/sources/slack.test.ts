import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

// The slack connector's pure logic (self-search query building, timestamp and
// updated-time sorting of untrusted API payloads, conversation dedupe, stream
// normalization, and the error-to-warning downgrades) is private and only
// observable by driving `ingest()` with a stubbed `fetch`. These tests point
// $HOME at a throwaway temp dir, feed controlled Slack Web API responses, and
// assert on the request the connector builds and the normalized raw dump it
// writes to disk. No real Slack API call or OAuth token is involved.

const originalEnv: Record<string, string | undefined> = {};
const TRACKED_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "OPENWIKI_SLACK_USER_TOKEN",
  "OPENWIKI_SLACK_USER_REFRESH_TOKEN",
  "OPENWIKI_SLACK_USER_TOKEN_EXPIRES_AT",
  "OPENWIKI_SLACK_USER_TOKEN_TYPE",
] as const;
const tempHomes: string[] = [];

for (const key of TRACKED_ENV_KEYS) {
  originalEnv[key] = process.env[key];
}

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-slack-source-"));
  tempHomes.push(home);
  return home;
}

async function writeConnectorConfig(
  home: string,
  config: unknown,
): Promise<void> {
  const dir = path.join(home, ".openwiki", "connectors", "slack");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

async function loadSlackConnector(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // A fresh, non-expiring token so getOAuthAccessToken short-circuits without
  // touching the OAuth refresh machinery.
  process.env.OPENWIKI_SLACK_USER_TOKEN = "slack-user-token";
  delete process.env.OPENWIKI_SLACK_USER_TOKEN_EXPIRES_AT;
  const { createSlackConnector } =
    await import("../../../src/connectors/sources/slack.ts");
  return createSlackConnector();
}

function getRequestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

interface SlackCall {
  method: string;
  params: Record<string, string>;
}

/**
 * Stubs global fetch for the Slack Web API. The handler is keyed on the API
 * method (the last URL path segment) and receives the decoded form params, so
 * tests can branch on e.g. the `channel` of a conversations.history call. A
 * numeric return is treated as an HTTP status (to exercise the non-ok path).
 */
function stubSlack(
  handler: (method: string, params: Record<string, string>) => unknown,
): SlackCall[] {
  const calls: SlackCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(getRequestUrl(input));
      const method = url.pathname.split("/").pop() ?? "";
      const params: Record<string, string> = {};
      if (init?.body instanceof URLSearchParams) {
        for (const [key, value] of init.body.entries()) {
          params[key] = value;
        }
      }
      calls.push({ method, params });
      const body = handler(method, params);

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
  return calls;
}

async function readRaw(rawFiles: string[], suffix: string): Promise<unknown> {
  const file = rawFiles.find((entry) => entry.endsWith(suffix));
  expect(file, `expected a raw dump ending in ${suffix}`).toBeDefined();
  return JSON.parse(await readFile(file as string, "utf8"));
}

const AUTH_OK = {
  ok: true,
  team: "Example",
  team_id: "TABC123",
  url: "https://example.slack.com",
  user_id: "UABC123",
};

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

describe("slack connector gates", () => {
  test("skips when config is disabled", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, { enabled: false });
    const connector = await loadSlackConnector(home);
    delete process.env.OPENWIKI_SLACK_USER_TOKEN;

    const result = await connector.ingest();

    expect(result.status).toBe("skipped");
  });

  test("errors when the user token env is unset", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, { enabled: true });
    const connector = await loadSlackConnector(home);
    delete process.env.OPENWIKI_SLACK_USER_TOKEN;

    const result = await connector.ingest();

    expect(result.status).toBe("error");
    expect(result.message).toContain("OPENWIKI_SLACK_USER_TOKEN");
  });

  test("throws when a Slack API request returns a non-ok status", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, {
      enabled: true,
      streams: ["my_messages_search"],
    });
    stubSlack(() => 500);
    const connector = await loadSlackConnector(home);

    await expect(connector.ingest()).rejects.toThrow(
      "Slack API request failed: 500",
    );
  });
});

describe("slack self-message search normalization", () => {
  test("sorts matches by timestamp descending and reports the total", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, {
      enabled: true,
      myMessagesSearchLimit: 20,
      streams: ["my_messages_search"],
    });
    const calls = stubSlack((method) => {
      if (method === "auth.test") {
        return AUTH_OK;
      }
      if (method === "users.info") {
        return { ok: true, user: { id: "UABC123", name: "angel" } };
      }
      if (method === "search.messages") {
        // Deliberately out of order to prove the connector re-sorts.
        return {
          ok: true,
          messages: {
            matches: [
              {
                channel: { id: "C1", name: "general" },
                text: "older",
                ts: "100.0",
              },
              {
                channel: { id: "C2", is_im: true },
                text: "newest",
                ts: "300.0",
              },
            ],
            total: 2,
          },
        };
      }
      return { ok: true };
    });
    const connector = await loadSlackConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    // The self-search query must target the authenticated user id.
    const searchCall = calls.find((call) => call.method === "search.messages");
    expect(searchCall?.params.query).toBe("from:<@UABC123>");
    expect(searchCall?.params.sort).toBe("timestamp");
    expect(searchCall?.params.sort_dir).toBe("desc");

    const dump = (await readRaw(
      result.rawFiles,
      "my-messages-search.json",
    )) as {
      coverage: { query: string; resultCount: number; total?: number };
      userMessages: { message: { text: string } }[];
    };
    expect(dump.userMessages.map((entry) => entry.message.text)).toEqual([
      "newest",
      "older",
    ]);
    expect(dump.coverage.total).toBe(2);
    expect(dump.coverage.resultCount).toBe(2);
    expect(dump.coverage.query).toBe("from:<@UABC123>");
  });

  test("downgrades a search API error to a warning and continues", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, {
      enabled: true,
      streams: ["my_messages_search"],
    });
    stubSlack((method) => {
      if (method === "auth.test") {
        return AUTH_OK;
      }
      if (method === "users.info") {
        return { ok: true, user: { id: "UABC123" } };
      }
      if (method === "search.messages") {
        // ok:false with a `needed` scope must surface in the thrown message,
        // which is then caught and turned into a warning rather than aborting.
        return { error: "missing_scope", needed: "search:read", ok: false };
      }
      return { ok: true };
    });
    const connector = await loadSlackConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(
      result.warnings.some(
        (warning) =>
          warning.includes("Slack self-message search failed") &&
          warning.includes("missing_scope") &&
          warning.includes("needed=search:read"),
      ),
    ).toBe(true);
  });

  test("skips self-search with a warning when auth.test omits user_id", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, {
      enabled: true,
      streams: ["my_messages_search"],
    });
    const calls = stubSlack((method) => {
      if (method === "auth.test") {
        // No user_id: the connector cannot build the self-search query.
        return { ok: true, team: "Example", team_id: "TABC123" };
      }
      return { ok: true };
    });
    const connector = await loadSlackConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    // Without a user id, users.info must not be queried either.
    expect(calls.some((call) => call.method === "users.info")).toBe(false);
    expect(
      result.warnings.some((warning) =>
        warning.includes("auth.test did not return a user_id"),
      ),
    ).toBe(true);
  });

  test("fails self-search safely when auth.test returns an invalid user_id", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, {
      enabled: true,
      streams: ["my_messages_search"],
    });
    stubSlack((method) => {
      if (method === "auth.test") {
        // A user_id that does not match the U/W-prefixed Slack id shape must be
        // rejected before it is interpolated into the search query.
        return { ...AUTH_OK, user_id: "not-valid" };
      }
      if (method === "users.info") {
        return { ok: true, user: { id: "not-valid" } };
      }
      return { ok: true };
    });
    const connector = await loadSlackConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(
      result.warnings.some(
        (warning) =>
          warning.includes("Slack self-message search failed") &&
          warning.includes("invalid user_id"),
      ),
    ).toBe(true);
  });

  test("returns undefined identity user when users.info fails", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, {
      enabled: true,
      streams: ["my_messages_search"],
    });
    stubSlack((method) => {
      if (method === "auth.test") {
        return AUTH_OK;
      }
      if (method === "users.info") {
        // A failed users.info must be swallowed, leaving identity.user unset
        // rather than aborting the whole run.
        return { error: "user_not_found", ok: false };
      }
      if (method === "search.messages") {
        return { ok: true, messages: { matches: [], total: 0 } };
      }
      return { ok: true };
    });
    const connector = await loadSlackConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    const identity = (await readRaw(result.rawFiles, "identity.json")) as {
      user: unknown;
    };
    expect(identity.user ?? null).toBeNull();
  });
});

describe("slack recent-history normalization", () => {
  test("collects the user's own messages, dedupes and sorts conversations", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, {
      conversationScanLimit: 10,
      enabled: true,
      maxConversations: 5,
      // A non-finite value must clamp to the minimum rather than crash.
      messagesPerConversation: null,
      // A bare ["recent_messages"] must be normalized to also run the
      // self-search stream that recent-history depends on for the latest msg.
      streams: ["recent_messages"],
    });
    const calls = stubSlack((method, params) => {
      if (method === "auth.test") {
        return AUTH_OK;
      }
      if (method === "users.info") {
        return { ok: true, user: { id: "UABC123" } };
      }
      if (method === "search.messages") {
        // An array (not an object) payload must yield an undefined total and an
        // empty match set, forcing the conversations.history fallback path.
        return { messages: [], ok: true };
      }
      if (method === "conversations.list") {
        return {
          channels: [
            { id: "C1", name: "alpha", updated: 10 },
            { id: "C2", name: "beta", updated: 30 },
            { id: "C1", name: "alpha-dupe", updated: 10 },
            { id: "C3", name: "gamma" },
          ],
          ok: true,
          response_metadata: {},
        };
      }
      if (method === "conversations.history") {
        if (params.channel === "C2") {
          // No ts on this self-message: it must sort as timestamp 0 (oldest)
          // via the comparator without throwing.
          return {
            messages: [{ text: "m2", user: "UABC123" }],
            ok: true,
          };
        }
        if (params.channel === "C1") {
          return {
            messages: [
              { text: "m1", ts: "900.0", user: "UABC123" },
              { text: "other", ts: "800.0", user: "OTHERUSER" },
            ],
            ok: true,
          };
        }
        return { messages: [], ok: true };
      }
      return { ok: true };
    });
    const connector = await loadSlackConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    // The normalization prepended my_messages_search before recent_messages.
    const methods = calls.map((call) => call.method);
    expect(methods).toContain("search.messages");
    expect(
      methods.filter((method) => method === "conversations.history"),
    ).toHaveLength(3);

    const dump = (await readRaw(result.rawFiles, "recent-messages.json")) as {
      conversations: { conversation: { id: string } }[];
      userMessages: { message: { text: string } }[];
    };
    // Conversations are deduped (C1 once) and sorted by updated desc: C2, C1, C3.
    expect(dump.conversations.map((entry) => entry.conversation.id)).toEqual([
      "C2",
      "C1",
      "C3",
    ]);
    // Only the authenticated user's messages, newest ts first, across channels.
    expect(dump.userMessages.map((entry) => entry.message.text)).toEqual([
      "m1",
      "m2",
    ]);
  });

  test("treats a non-numeric message timestamp as zero when sorting", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, {
      enabled: true,
      maxConversations: 5,
      messagesPerConversation: 10,
      streams: ["recent_messages"],
    });
    stubSlack((method, params) => {
      if (method === "auth.test") {
        return AUTH_OK;
      }
      if (method === "users.info") {
        return { ok: true, user: { id: "UABC123" } };
      }
      if (method === "search.messages") {
        return { messages: [], ok: true };
      }
      if (method === "conversations.list") {
        return {
          channels: [{ id: "C1", name: "alpha", updated: 10 }],
          ok: true,
          response_metadata: {},
        };
      }
      if (method === "conversations.history" && params.channel === "C1") {
        // A garbage (non-numeric) ts must be treated as timestamp 0 by the
        // comparator, sorting below the well-formed message rather than
        // producing NaN and an unstable order.
        return {
          messages: [
            { text: "bad", ts: "not-a-number", user: "UABC123" },
            { text: "good", ts: "900.0", user: "UABC123" },
          ],
          ok: true,
        };
      }
      return { messages: [], ok: true };
    });
    const connector = await loadSlackConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    const dump = (await readRaw(result.rawFiles, "recent-messages.json")) as {
      userMessages: { message: { text: string } }[];
    };
    expect(dump.userMessages.map((entry) => entry.message.text)).toEqual([
      "good",
      "bad",
    ]);
  });

  test("warns and handles a missing timestamp when the user has one message", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, {
      enabled: true,
      maxConversations: 5,
      streams: ["recent_messages"],
    });
    stubSlack((method, params) => {
      if (method === "auth.test") {
        return AUTH_OK;
      }
      if (method === "users.info") {
        return { ok: true, user: { id: "UABC123" } };
      }
      if (method === "search.messages") {
        return { messages: [], ok: true };
      }
      if (method === "conversations.list") {
        return {
          channels: [{ id: "C1", name: "alpha", updated: 10 }],
          ok: true,
          response_metadata: {},
        };
      }
      if (method === "conversations.history" && params.channel === "C1") {
        // A single self-message with no ts must sort as timestamp 0 without
        // throwing, and trip the low-coverage warning.
        return { messages: [{ text: "only", user: "UABC123" }], ok: true };
      }
      return { messages: [], ok: true };
    });
    const connector = await loadSlackConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(
      result.warnings.some((warning) =>
        warning.includes("one or fewer authenticated-user messages"),
      ),
    ).toBe(true);
    const dump = (await readRaw(result.rawFiles, "recent-messages.json")) as {
      userMessages: { message: { text: string } }[];
    };
    expect(dump.userMessages).toHaveLength(1);
  });
});

describe("slack assistant search", () => {
  test("warns when assistant_search is requested with no queries", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, {
      assistantSearchQueries: [],
      enabled: true,
      streams: ["assistant_search"],
    });
    stubSlack((method) => {
      if (method === "auth.test") {
        return AUTH_OK;
      }
      return { ok: true, user: { id: "UABC123" } };
    });
    const connector = await loadSlackConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(result.warnings).toContain(
      "assistant_search requested but assistantSearchQueries is empty.",
    );
  });

  test("issues one context query per configured query", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, {
      assistantSearchQueries: ["release notes", "roadmap"],
      enabled: true,
      streams: ["assistant_search"],
    });
    const calls = stubSlack((method) => {
      if (method === "auth.test") {
        return AUTH_OK;
      }
      if (method === "users.info") {
        return { ok: true, user: { id: "UABC123" } };
      }
      return { ok: true, results: [] };
    });
    const connector = await loadSlackConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    const contextCalls = calls.filter(
      (call) => call.method === "assistant.search.context",
    );
    expect(contextCalls.map((call) => call.params.query)).toEqual([
      "release notes",
      "roadmap",
    ]);

    const dump = (await readRaw(result.rawFiles, "assistant-search.json")) as {
      searches: { query: string }[];
    };
    expect(dump.searches.map((entry) => entry.query)).toEqual([
      "release notes",
      "roadmap",
    ]);
  });
});
