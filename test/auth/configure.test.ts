import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempHomes: string[] = [];

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-auth-configure-"));
  tempHomes.push(home);
  return home;
}

async function loadConfigure(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return await import("../../src/auth/configure.ts");
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<
    string,
    unknown
  >;
}

afterEach(async () => {
  vi.resetModules();

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

describe("configureAuthProvider", () => {
  test("creates a default connector config on first run", async () => {
    const home = await createTempHome();
    const { configureAuthProvider } = await loadConfigure(home);

    const result = await configureAuthProvider("notion");

    expect(result.status).toBe("created");
    expect(result.provider).toBe("notion");
    expect(result.nextSteps[0]).toBe("Review the generated connector config.");

    const config = await readJson(result.configPath);
    expect(config.enabled).toBe(true);
    expect(config.transport).toMatchObject({
      type: "http",
      url: "https://mcp.notion.com/mcp",
    });
  });

  test("maps gmail to the google connector and writes gmail defaults", async () => {
    const home = await createTempHome();
    const { configureAuthProvider } = await loadConfigure(home);

    const result = await configureAuthProvider("gmail");

    expect(result.status).toBe("created");
    expect(result.configPath).toContain(path.join("connectors", "google"));
    const config = await readJson(result.configPath);
    expect(config).toMatchObject({ provider: "gmail", query: "newer_than:1d" });
  });

  test("preserves an existing config and reports exists without --force", async () => {
    const home = await createTempHome();
    const { configureAuthProvider } = await loadConfigure(home);

    await configureAuthProvider("slack");
    const second = await configureAuthProvider("slack");

    expect(second.status).toBe("exists");
    expect(second.nextSteps[0]).toContain("pass --force to overwrite");
  });

  test("overwrites an existing config when --force is passed", async () => {
    const home = await createTempHome();
    const { configureAuthProvider } = await loadConfigure(home);

    await configureAuthProvider("slack");
    const forced = await configureAuthProvider("slack", { force: true });

    expect(forced.status).toBe("updated");
    expect(forced.nextSteps[0]).toBe("Review the generated connector config.");
  });
});

describe("shouldDiscoverToolsAfterAuth", () => {
  test("is true only for MCP-backed providers", async () => {
    const home = await createTempHome();
    const { shouldDiscoverToolsAfterAuth } = await loadConfigure(home);

    expect(shouldDiscoverToolsAfterAuth("notion")).toBe(true);
    expect(shouldDiscoverToolsAfterAuth("slack")).toBe(false);
    expect(shouldDiscoverToolsAfterAuth("gmail")).toBe(false);
  });
});

describe("listAuthProviderTools", () => {
  test("throws with setup guidance when no config exists yet", async () => {
    const home = await createTempHome();
    const { listAuthProviderTools } = await loadConfigure(home);

    await expect(listAuthProviderTools("x")).rejects.toThrow(
      "Run openwiki auth x first",
    );
  });

  test("throws when the provider does not expose MCP tools", async () => {
    const home = await createTempHome();
    const { configureAuthProvider, listAuthProviderTools } =
      await loadConfigure(home);

    await configureAuthProvider("slack");

    await expect(listAuthProviderTools("slack")).rejects.toThrow(
      "does not expose MCP tools",
    );
  });
});
