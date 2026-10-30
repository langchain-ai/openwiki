import type { StructuredToolInterface } from "@langchain/core/tools";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempHomes: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnv("HOME", originalHome);
  restoreEnv("USERPROFILE", originalUserProfile);

  await Promise.all(
    tempHomes
      .splice(0)
      .map((home) => rm(home, { force: true, recursive: true })),
  );
});

describe("raw dump read race", () => {
  test("read retries ENOENT until a dump written moments later is visible", async () => {
    const home = await createTempHome();
    const { connectorIo, tools } = await loadConnectorModules(home);
    const runId = "2026-07-27T00-00-00-000Z";
    const dump = {
      fetchedAt: "2026-07-27T00:00:00.000Z",
      pages: [{ data: [{ id: "1" }, { id: "2" }] }],
      stream: "bookmarks",
    };

    // Simulate the race from issue #460: synthesis starts reading the
    // reported path before the connector's write has landed on disk.
    const delayedWrite = (async () => {
      await sleep(60);
      await connectorIo.writeRawJson("x", runId, "bookmarks.json", dump);
    })();
    const result = await invokeJson<RawReadResult>(
      getTool(tools, "openwiki_read_raw_item"),
      { connectorId: "x", path: `${runId}/bookmarks.json` },
    );
    await delayedWrite;

    expect(JSON.parse(result.content)).toEqual(dump);
    expect(result.truncated).toBe(false);
  });

  test("read still throws ENOENT after bounded retries when the dump never appears", async () => {
    const home = await createTempHome();
    const { tools } = await loadConnectorModules(home);

    await expect(
      getTool(tools, "openwiki_read_raw_item").invoke({
        connectorId: "x",
        path: "2026-07-27T00-00-00-000Z/missing.json",
      }),
    ).rejects.toThrow(/ENOENT/u);
  });

  test("writeRawJson publishes the dump atomically with no temp files left behind", async () => {
    const home = await createTempHome();
    const { connectorIo } = await loadConnectorModules(home);
    const runId = "2026-07-27T00-00-00-000Z";
    const dump = { pages: [{ data: [{ id: "1" }] }], stream: "bookmarks" };

    const filePath = await connectorIo.writeRawJson(
      "x",
      runId,
      "bookmarks.json",
      dump,
    );

    // The path the connector reports must already hold the complete dump,
    // and no intermediate temp file may remain next to it.
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(dump);
    expect(await readdir(path.dirname(filePath))).toEqual(["bookmarks.json"]);

    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });
});

interface RawReadResult {
  content: string;
  truncated: boolean;
}

async function loadConnectorModules(home: string): Promise<{
  connectorIo: typeof import("../src/connectors/io.ts");
  tools: StructuredToolInterface[];
}> {
  vi.resetModules();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const { createOpenWikiConnectorTools } =
    await import("../src/connectors/tools.ts");
  const connectorIo = await import("../src/connectors/io.ts");

  return { connectorIo, tools: createOpenWikiConnectorTools() };
}

function getTool(
  tools: StructuredToolInterface[],
  name: string,
): StructuredToolInterface {
  const tool = tools.find((candidate) => candidate.name === name);

  if (!tool) {
    throw new Error(`Missing connector tool: ${name}`);
  }

  return tool;
}

async function invokeJson<T>(
  tool: StructuredToolInterface,
  input: Record<string, unknown>,
): Promise<T> {
  const result: unknown = await tool.invoke(input);

  if (typeof result !== "string") {
    throw new Error("Expected connector tool to return a JSON string.");
  }

  return JSON.parse(result) as T;
}

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-dump-race-"));
  tempHomes.push(home);

  return home;
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
