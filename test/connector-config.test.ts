import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { normalizeStringArray } from "../src/connectors/config.ts";
import type { ConnectorId } from "../src/connectors/types.ts";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempHomes: string[] = [];

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

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-connector-config-"));
  tempHomes.push(home);
  return home;
}

async function writeConnectorConfigRaw(
  home: string,
  connectorId: ConnectorId,
  contents: string,
): Promise<string> {
  const configPath = getTestConnectorConfigPath(home, connectorId);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, contents, "utf8");

  return configPath;
}

function getTestConnectorConfigPath(
  home: string,
  connectorId: ConnectorId,
): string {
  return path.join(home, ".openwiki", "connectors", connectorId, "config.json");
}

async function loadConnectorIo(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  return import("../src/connectors/io.ts");
}

describe("readConnectorConfig", () => {
  test("returns the default config when the config file is missing", async () => {
    const home = await createTempHome();
    const { readConnectorConfig } = await loadConnectorIo(home);

    await expect(
      readConnectorConfig("google", {
        enabled: false,
        format: "metadata",
        maxMessages: 10,
      }),
    ).resolves.toEqual({
      enabled: false,
      format: "metadata",
      maxMessages: 10,
    });
  });

  test("merges a valid object config over defaults", async () => {
    const home = await createTempHome();
    await writeConnectorConfigRaw(
      home,
      "google",
      `${JSON.stringify({ enabled: true, maxMessages: 5 }, null, 2)}\n`,
    );
    const { readConnectorConfig } = await loadConnectorIo(home);

    await expect(
      readConnectorConfig("google", {
        enabled: false,
        format: "metadata",
        maxMessages: 10,
      }),
    ).resolves.toEqual({
      enabled: true,
      format: "metadata",
      maxMessages: 5,
    });
  });

  test("adds connector and path context for invalid JSON", async () => {
    const home = await createTempHome();
    const configPath = await writeConnectorConfigRaw(home, "slack", "{");
    const { readConnectorConfig } = await loadConnectorIo(home);

    await expect(
      readConnectorConfig("slack", { enabled: false }),
    ).rejects.toThrow("Invalid JSON in connector config for slack");
    await expect(
      readConnectorConfig("slack", { enabled: false }),
    ).rejects.toThrow(configPath);
  });

  test.each([
    ["null", "null"],
    ["array", "[]"],
    ["boolean", "true"],
    ["number", "42"],
    ["string", JSON.stringify("enabled")],
  ])("rejects %s JSON config values", async (_label, contents) => {
    const home = await createTempHome();
    const configPath = await writeConnectorConfigRaw(home, "x", contents);
    const { readConnectorConfig } = await loadConnectorIo(home);

    await expect(readConnectorConfig("x", { enabled: false })).rejects.toThrow(
      `Invalid connector config for x at ${configPath}: expected a JSON object.`,
    );
  });
});

describe("normalizeStringArray", () => {
  test("keeps non-empty strings and trims each", () => {
    expect(normalizeStringArray(["  a ", "b", "  c"])).toEqual(["a", "b", "c"]);
  });

  test("drops blank and whitespace-only entries", () => {
    expect(normalizeStringArray(["a", "", "   ", "b"])).toEqual(["a", "b"]);
  });

  test("drops non-string entries", () => {
    expect(normalizeStringArray(["a", 1, null, undefined, {}, "b"])).toEqual([
      "a",
      "b",
    ]);
  });

  test("returns an empty array for a non-array value", () => {
    expect(normalizeStringArray("a,b,c")).toEqual([]);
    expect(normalizeStringArray(undefined)).toEqual([]);
    expect(normalizeStringArray(null)).toEqual([]);
    expect(normalizeStringArray(42)).toEqual([]);
  });

  test("returns an empty array for an empty array", () => {
    expect(normalizeStringArray([])).toEqual([]);
  });
});
