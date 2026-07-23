import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalHome = process.env.HOME;
const tempHomes: string[] = [];

const CONNECTOR_ENV_KEYS = [
  "OPENWIKI_CONFLUENCE_EMAIL",
  "OPENWIKI_CONFLUENCE_API_TOKEN",
] as const;
const savedEnv: Record<string, string | undefined> = {};

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-confluence-"));
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

function clearConnectorTokens(): void {
  for (const key of CONNECTOR_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}

afterEach(async () => {
  vi.resetModules();
  vi.unstubAllGlobals();

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
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

async function loadConfluenceConnector(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  clearConnectorTokens();
  const { createConfluenceConnector } =
    await import("../src/connectors/sources/confluence.ts");
  return createConfluenceConnector();
}

describe("confluence connector", () => {
  test("skips when on-disk config is disabled and no override is given", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, "confluence", { enabled: false });
    const connector = await loadConfluenceConnector(home);

    const result = await connector.ingest();

    expect(result.status).toBe("skipped");
    expect(result.connectorId).toBe("confluence");
    expect(result.message).toContain("not enabled");
  });

  test("override enabled=true moves past enabled gate to credential gate", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, "confluence", { enabled: false });
    const connector = await loadConfluenceConnector(home);

    const result = await connector.ingest({
      connectorConfig: { enabled: true },
    });

    // Merge honored: enabled gate passed, so it stops at the missing-token gate.
    expect(result.status).toBe("error");
    expect(result.message).toContain("OPENWIKI_CONFLUENCE_EMAIL");
  });

  test("returns error when baseUrl is missing", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, "confluence", {
      baseUrl: "",
      enabled: true,
    });
    const connector = await loadConfluenceConnector(home);
    process.env.OPENWIKI_CONFLUENCE_EMAIL = "user@example.com";
    process.env.OPENWIKI_CONFLUENCE_API_TOKEN = "fake-token";

    const result = await connector.ingest();

    expect(result.status).toBe("error");
    expect(result.message).toContain("baseUrl");
  });

  test("fetches recent blogposts on success", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, "confluence", {
      baseUrl: "https://test.atlassian.net",
      enabled: true,
      streams: ["recent_blogposts"],
      windowDays: 30,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input);

        if (url.includes("/wiki/api/v2/blogposts")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                results: [
                  {
                    id: "bp-1",
                    title: "Test Blog Post",
                    status: "current",
                    spaceId: "space-1",
                    createdAt: new Date().toISOString(),
                    version: {
                      createdAt: new Date().toISOString(),
                      number: 1,
                    },
                  },
                ],
              }),
              {
                headers: { "Content-Type": "application/json" },
                status: 200,
              },
            ),
          );
        }

        return Promise.resolve(
          new Response(JSON.stringify({ results: [] }), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          }),
        );
      }),
    );
    const connector = await loadConfluenceConnector(home);
    process.env.OPENWIKI_CONFLUENCE_EMAIL = "user@example.com";
    process.env.OPENWIKI_CONFLUENCE_API_TOKEN = "fake-token";

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(result.rawFiles.length).toBeGreaterThanOrEqual(1);
    expect(result.message).toContain("blog post");
  });

  test("resolves space and fetches space blogposts", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, "confluence", {
      baseUrl: "https://test.atlassian.net",
      enabled: true,
      spaceKeys: ["ENG"],
      streams: ["space_blogposts"],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input);

        if (url.includes("/wiki/api/v2/spaces") && url.includes("keys=ENG")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                results: [{ id: "space-1", key: "ENG", name: "Engineering" }],
              }),
              {
                headers: { "Content-Type": "application/json" },
                status: 200,
              },
            ),
          );
        }

        if (url.includes("/wiki/api/v2/spaces/space-1/blogposts")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                results: [
                  {
                    id: "bp-2",
                    title: "Space Blog Post",
                    status: "current",
                    spaceId: "space-1",
                  },
                ],
              }),
              {
                headers: { "Content-Type": "application/json" },
                status: 200,
              },
            ),
          );
        }

        return Promise.resolve(
          new Response(JSON.stringify({ results: [] }), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          }),
        );
      }),
    );
    const connector = await loadConfluenceConnector(home);
    process.env.OPENWIKI_CONFLUENCE_EMAIL = "user@example.com";
    process.env.OPENWIKI_CONFLUENCE_API_TOKEN = "fake-token";

    const result = await connector.ingest();

    expect(result.status).toBe("success");
    expect(result.rawFiles.length).toBeGreaterThanOrEqual(1);
  });

  test("warns when space key cannot be resolved", async () => {
    const home = await createTempHome();
    await writeConnectorConfig(home, "confluence", {
      baseUrl: "https://test.atlassian.net",
      enabled: true,
      spaceKeys: ["NONEXISTENT"],
      streams: ["space_blogposts"],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ results: [] }), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          }),
        ),
      ),
    );
    const connector = await loadConfluenceConnector(home);
    process.env.OPENWIKI_CONFLUENCE_EMAIL = "user@example.com";
    process.env.OPENWIKI_CONFLUENCE_API_TOKEN = "fake-token";

    const result = await connector.ingest();

    expect(result.warnings).toContain(
      "Could not resolve space key: NONEXISTENT",
    );
  });

  test("connector definition has correct fields", async () => {
    const home = await createTempHome();
    const connector = await loadConfluenceConnector(home);

    expect(connector.id).toBe("confluence");
    expect(connector.backend).toBe("direct-api");
    expect(connector.displayName).toBe("Confluence");
    expect(connector.supportsAgenticDiscovery).toBe(false);
    expect(connector.requiredEnv).toEqual([
      "OPENWIKI_CONFLUENCE_EMAIL",
      "OPENWIKI_CONFLUENCE_API_TOKEN",
    ]);
  });
});
