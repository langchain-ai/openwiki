import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

// The gmail, slack, and x connectors read their on-disk config from
// `~/.openwiki/connectors/<id>/config.json` (a path derived from
// `os.homedir()`, which honors $HOME). These tests point $HOME at a throwaway
// temp dir and write a config file there, so we can assert that per-instance
// `options.connectorConfig` overrides are merged on top of the on-disk config
// — the bug this PR fixes, where gmail/slack/x silently ignored the overrides.
//
// Most cases short-circuit before any network call:
//   1. an `enabled` gate  -> returns status "skipped" when disabled
//   2. a credentials gate -> returns status "error"   when the token env is unset
// so the observable effect of the merge is which gate the run stops at, with no
// `fetch` involved. The malformed array tests stub `fetch` explicitly.

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempHomes: string[] = [];

const CONNECTOR_ENV_KEYS = [
  "OPENWIKI_GMAIL_ACCESS_TOKEN",
  "OPENWIKI_GMAIL_REFRESH_TOKEN",
  "OPENWIKI_GMAIL_TOKEN_EXPIRES_AT",
  "OPENWIKI_GMAIL_TOKEN_TYPE",
  "OPENWIKI_X_ACCESS_TOKEN",
  "OPENWIKI_X_CLIENT_ID",
  "OPENWIKI_X_REFRESH_TOKEN",
  "OPENWIKI_X_TOKEN_EXPIRES_AT",
  "OPENWIKI_X_TOKEN_TYPE",
  "OPENWIKI_SLACK_CLIENT_ID",
  "OPENWIKI_SLACK_CLIENT_SECRET",
  "OPENWIKI_SLACK_USER_TOKEN",
  "OPENWIKI_SLACK_USER_REFRESH_TOKEN",
  "OPENWIKI_SLACK_USER_TOKEN_EXPIRES_AT",
  "OPENWIKI_SLACK_USER_TOKEN_TYPE",
] as const;
const savedEnv: Record<string, string | undefined> = {};

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-connector-config-"));
  tempHomes.push(home);
  return home;
}

async function writeConnectorConfig(
  home: string,
  connectorId: string,
  config: unknown,
): Promise<void> {
  const dir = path.join(home, ".openwiki", "connectors", connectorId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
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

  for (const key of CONNECTOR_ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }

  await Promise.all(
    tempHomes
      .splice(0)
      .map((home) => rm(home, { force: true, recursive: true })),
  );
});

function clearConnectorTokens(): void {
  for (const key of CONNECTOR_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}

function setConnectorTestHome(home: string): void {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
}

async function loadXConnector(home: string) {
  vi.resetModules();
  setConnectorTestHome(home);
  clearConnectorTokens();
  const { createXConnector } = await import("../src/connectors/sources/x.ts");
  return createXConnector();
}

async function loadSlackConnector(home: string) {
  vi.resetModules();
  setConnectorTestHome(home);
  clearConnectorTokens();
  const { createSlackConnector } =
    await import("../src/connectors/sources/slack.ts");
  return createSlackConnector();
}

async function loadGmailConnector(home: string) {
  vi.resetModules();
  setConnectorTestHome(home);
  clearConnectorTokens();
  const { createGmailConnector } =
    await import("../src/connectors/sources/gmail.ts");
  return createGmailConnector();
}

function getRequestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

describe("x connector honors options.connectorConfig", () => {
  test("skips when on-disk config is disabled and no override is given", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, "x", { enabled: false });
    const connector = await loadXConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("skipped");
  });

  test("override enabled=true moves past the enabled gate to the token gate", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, "x", { enabled: false });
    const connector = await loadXConnector(home);

    const result = await connector.ingest({
      connectorConfig: { enabled: true },
    });

    // Merge honored: enabled gate passed, so it stops at the missing-token gate.
    // If the override were ignored (the bug), status would still be "skipped".
    expect(result.status).toBe("error");
    expect(result.message).toContain("OPENWIKI_X_ACCESS_TOKEN");
  });

  test("normalizes malformed non-array stream and list config", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, "x", {
      enabled: true,
      listIds: "12345",
      maxPagesPerStream: 1,
      streams: "list_posts",
      userId: "user-1",
    });
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = getRequestUrl(input);
        paths.push(new URL(url).pathname);

        return Promise.resolve(
          new Response(JSON.stringify({ data: [], meta: {} }), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          }),
        );
      }),
    );
    const connector = await loadXConnector(home);
    process.env.OPENWIKI_X_ACCESS_TOKEN = "x-access-token";

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(result.rawFiles).toHaveLength(4);
    expect(paths).toEqual([
      "/2/users/user-1/timelines/reverse_chronological",
      "/2/users/user-1/tweets",
      "/2/users/user-1/mentions",
      "/2/users/user-1/bookmarks",
    ]);
    expect(
      paths.some((requestPath) => requestPath.startsWith("/2/lists/")),
    ).toBe(false);
  });
});

describe("slack connector honors options.connectorConfig", () => {
  test("skips when on-disk config is disabled and no override is given", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, "slack", { enabled: false });
    const connector = await loadSlackConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("skipped");
  });

  test("override enabled=true moves past the enabled gate to the token gate", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, "slack", { enabled: false });
    const connector = await loadSlackConnector(home);

    const result = await connector.ingest({
      connectorConfig: { enabled: true },
    });

    expect(result.status).toBe("error");
    expect(result.message).toContain("OPENWIKI_SLACK_USER_TOKEN");
  });

  test("normalizes malformed non-array stream and conversation type config", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, "slack", {
      conversationScanLimit: 1,
      conversationTypes: "im",
      enabled: true,
      maxConversations: 1,
      messagesPerConversation: 1,
      myMessagesSearchLimit: 1,
      streams: "recent_messages",
    });
    const methods: string[] = [];
    const conversationTypes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = getRequestUrl(input);
        const method = new URL(url).pathname.split("/").pop() ?? "";
        methods.push(method);

        if (
          method === "conversations.list" &&
          init?.body instanceof URLSearchParams
        ) {
          conversationTypes.push(init.body.get("types") ?? "");
        }

        const body =
          method === "auth.test"
            ? {
                ok: true,
                team: "Example",
                team_id: "TABC123",
                url: "https://example.slack.com",
                user_id: "UABC123",
              }
            : method === "users.info"
              ? { ok: true, user: { id: "UABC123", name: "angel" } }
              : method === "search.messages"
                ? { ok: true, messages: { matches: [], total: 0 } }
                : method === "conversations.list"
                  ? {
                      channels: [
                        { id: "CABC123", name: "general", updated: 10 },
                      ],
                      ok: true,
                      response_metadata: {},
                    }
                  : { ok: true, messages: [] };

        return Promise.resolve(
          new Response(JSON.stringify(body), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          }),
        );
      }),
    );
    const connector = await loadSlackConnector(home);
    process.env.OPENWIKI_SLACK_USER_TOKEN = "slack-user-token";

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(methods).toEqual([
      "auth.test",
      "users.info",
      "search.messages",
      "conversations.list",
      "conversations.history",
    ]);
    expect(conversationTypes).toEqual([
      "public_channel,private_channel,im,mpim",
    ]);
  });

  test("normalizes malformed non-array assistant search queries to empty", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, "slack", {
      assistantSearchQueries: "release notes",
      enabled: true,
      streams: ["assistant_search"],
    });
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = getRequestUrl(input);
        const method = new URL(url).pathname.split("/").pop() ?? "";
        methods.push(method);

        const body =
          method === "auth.test"
            ? {
                ok: true,
                team: "Example",
                team_id: "TABC123",
                url: "https://example.slack.com",
                user_id: "UABC123",
              }
            : { ok: true, user: { id: "UABC123", name: "angel" } };

        return Promise.resolve(
          new Response(JSON.stringify(body), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          }),
        );
      }),
    );
    const connector = await loadSlackConnector(home);
    process.env.OPENWIKI_SLACK_USER_TOKEN = "slack-user-token";

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(methods).toEqual(["auth.test", "users.info"]);
    expect(result.warnings).toContain(
      "assistant_search requested but assistantSearchQueries is empty.",
    );
  });
});

describe("gmail connector honors options.connectorConfig", () => {
  test("override enabled=false skips even though on-disk config is enabled", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, "google", { enabled: true });
    const connector = await loadGmailConnector(home);

    const result = await connector.ingest({
      connectorConfig: { enabled: false },
    });

    // Merge honored: the override disables the run before any Gmail API call.
    // If the override were ignored (the bug), it would proceed past this gate.
    expect(result.status).toBe("skipped");
  });

  test("ignores malformed non-array list config instead of crashing", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, "google", {
      enabled: true,
      format: "metadata",
      labelIds: "INBOX",
      maxMessages: 1,
      metadataHeaders: "Subject",
    });
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input);
        requests.push(url);

        if (new URL(url).pathname.endsWith("/messages")) {
          return Promise.resolve(
            new Response(JSON.stringify({ messages: [{ id: "msg-1" }] }), {
              headers: { "Content-Type": "application/json" },
              status: 200,
            }),
          );
        }

        return Promise.resolve(
          new Response(JSON.stringify({ id: "msg-1" }), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          }),
        );
      }),
    );
    const connector = await loadGmailConnector(home);
    process.env.OPENWIKI_GMAIL_ACCESS_TOKEN = "gmail-access-token";
    process.env.OPENWIKI_GMAIL_REFRESH_TOKEN = "gmail-refresh-token";

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(requests).toHaveLength(2);
    expect(new URL(requests[0] ?? "").searchParams.getAll("labelIds")).toEqual(
      [],
    );
    expect(
      new URL(requests[1] ?? "").searchParams.getAll("metadataHeaders"),
    ).toEqual([]);
  });
});
