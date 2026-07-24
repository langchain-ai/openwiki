import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

// The X connector fetches several independent streams per run. A failure on one
// stream (e.g. a 429 on `mentions`) must not abort the whole run: already-
// fetched dumps stay, other streams keep going, a warning is recorded, and
// state is still written so cursors advance (issue #412).
//
// $HOME points at a throwaway home so config/state live under
// `<home>/.openwiki/connectors/x/`. `userId` is set in config so the connector
// skips the `/users/me` lookup, and `fetch` is stubbed to make one stream fail.

const originalHome = process.env.HOME;
const tempHomes: string[] = [];
const savedToken = process.env.OPENWIKI_X_ACCESS_TOKEN;

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-x-stream-"));
  tempHomes.push(home);
  return home;
}

async function writeXConfig(home: string, config: unknown): Promise<void> {
  const dir = path.join(home, ".openwiki", "connectors", "x");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

async function loadXConnector(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  process.env.OPENWIKI_X_ACCESS_TOKEN = "x-access-token";
  const { createXConnector } = await import("../src/connectors/sources/x.ts");
  return createXConnector();
}

afterEach(async () => {
  vi.resetModules();
  vi.unstubAllGlobals();

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (savedToken === undefined) {
    delete process.env.OPENWIKI_X_ACCESS_TOKEN;
  } else {
    process.env.OPENWIKI_X_ACCESS_TOKEN = savedToken;
  }

  await Promise.all(
    tempHomes
      .splice(0)
      .map((home) => rm(home, { force: true, recursive: true })),
  );
});

describe("x connector isolates per-stream failures", () => {
  test("one failing stream records a warning but keeps the succeeding dump", async () => {
    const home = await createTempHome();
    await writeXConfig(home, {
      enabled: true,
      maxPagesPerStream: 1,
      streams: ["user_posts", "mentions"],
      userId: "42",
    });

    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input);
        requested.push(url);

        // `mentions` is rate-limited; `user_posts` (…/tweets) succeeds.
        if (new URL(url).pathname.endsWith("/mentions")) {
          return Promise.resolve(
            new Response("rate limited", {
              status: 429,
              statusText: "Too Many Requests",
            }),
          );
        }

        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [{ id: "100" }],
              meta: { newest_id: "100" },
            }),
            {
              headers: { "Content-Type": "application/json" },
              status: 200,
            },
          ),
        );
      }),
    );

    const connector = await loadXConnector(home);
    const result = await connector.ingest();

    // The run did not abort on the 429: it still produced the user_posts dump.
    expect(result.status).toBe("success");
    expect(result.rawFiles.some((f) => f.includes("user_posts"))).toBe(true);
    expect(result.rawFiles.some((f) => f.includes("mentions"))).toBe(false);
    // The failure is surfaced, not swallowed.
    expect(result.warnings.some((w) => w.startsWith("mentions:"))).toBe(true);
    // Both streams were attempted despite mentions failing.
    expect(requested.some((u) => u.includes("/mentions"))).toBe(true);
    expect(requested.some((u) => u.includes("/tweets"))).toBe(true);
  });

  test("all streams failing yields an error status, not a benign skip", async () => {
    const home = await createTempHome();
    await writeXConfig(home, {
      enabled: true,
      maxPagesPerStream: 1,
      streams: ["user_posts"],
      userId: "42",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response("boom", { status: 500, statusText: "Server Error" }),
        ),
      ),
    );

    const connector = await loadXConnector(home);
    const result = await connector.ingest();

    expect(result.status).toBe("error");
    expect(result.rawFiles).toHaveLength(0);
    expect(result.warnings.some((w) => w.startsWith("user_posts:"))).toBe(true);
  });
});
