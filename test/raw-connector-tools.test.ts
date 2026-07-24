import type { StructuredToolInterface } from "@langchain/core/tools";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

describe("raw connector tools", () => {
  test("lists raw files with POSIX separators before latest-run filtering", async () => {
    const home = await createTempHome();
    await writeRawFile(home, "x", "2026-07-19T000000Z/old.json", "{}");
    await writeRawFile(home, "x", "2026-07-20T000000Z/nested/new.json", "{}");
    const tools = await loadConnectorTools(home);
    const result = await invokeJson<RawItemsResult>(
      getTool(tools, "openwiki_list_raw_items"),
      { connectorId: "x" },
    );

    expect(result.files).toEqual([
      "2026-07-20T000000Z/nested/new.json",
      "2026-07-19T000000Z/old.json",
    ]);
    expect(result.latestRunId).toBe("2026-07-20T000000Z");
    expect(result.latestFiles).toEqual(["2026-07-20T000000Z/nested/new.json"]);
    expect(result.files.every((file) => !file.includes("\\"))).toBe(true);
  });

  test("normalizes Windows raw paths before run-id parsing", async () => {
    const { normalizeRawRelativePath } =
      await import("../src/connectors/tools.ts");

    expect(
      normalizeRawRelativePath("2026-07-20T000000Z\\nested\\new.json"),
    ).toBe("2026-07-20T000000Z/nested/new.json");
  });

  test("reads normal raw files with existing truncation behavior", async () => {
    const home = await createTempHome();
    await writeRawFile(home, "x", "2026-07-20T000000Z/normal.json", "abcdef");
    const tools = await loadConnectorTools(home);

    const result = await invokeJson<RawReadResult>(
      getTool(tools, "openwiki_read_raw_item"),
      {
        connectorId: "x",
        maxBytes: 3,
        path: "2026-07-20T000000Z/normal.json",
      },
    );

    expect(result.content).toBe("abc");
    expect(result.truncated).toBe(true);
    expect(result.filePath).toBe(
      path.join(
        home,
        ".openwiki",
        "connectors",
        "x",
        "raw",
        "2026-07-20T000000Z",
        "normal.json",
      ),
    );
  });

  test("rejects symlink raw item paths before reading", async () => {
    const home = await createTempHome();
    const runId = "2026-07-20T000000Z";
    const linkRelativePath = await createSymlinkRawItem(home, "x", runId);
    const tools = await loadConnectorTools(home);

    await expect(
      getTool(tools, "openwiki_read_raw_item").invoke({
        connectorId: "x",
        maxBytes: 100,
        path: linkRelativePath,
      }),
    ).rejects.toThrow(/symbolic links/u);
  });

  test("rejects symlink raw directories before listing", async () => {
    const home = await createTempHome();
    await createSymlinkRawDir(home, "x");
    const tools = await loadConnectorTools(home);

    await expect(
      getTool(tools, "openwiki_list_raw_items").invoke({ connectorId: "x" }),
    ).rejects.toThrow(/symbolic links/u);
  });

  test("rejects symlink raw directories before reading", async () => {
    const home = await createTempHome();
    const rawItemPath = await createSymlinkRawDir(home, "x");
    const tools = await loadConnectorTools(home);

    await expect(
      getTool(tools, "openwiki_read_raw_item").invoke({
        connectorId: "x",
        maxBytes: 100,
        path: rawItemPath,
      }),
    ).rejects.toThrow(/symbolic links/u);
  });
});

interface RawItemsResult {
  files: string[];
  latestFiles: string[];
  latestRunId: string | null;
}

interface RawReadResult {
  content: string;
  filePath: string;
  truncated: boolean;
}

async function loadConnectorTools(
  home: string,
): Promise<StructuredToolInterface[]> {
  vi.resetModules();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const { createOpenWikiConnectorTools } =
    await import("../src/connectors/tools.ts");

  return createOpenWikiConnectorTools();
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
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-raw-tools-"));
  tempHomes.push(home);

  return home;
}

async function writeRawFile(
  home: string,
  connectorId: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const filePath = rawPath(home, connectorId, ...relativePath.split("/"));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function createSymlinkRawItem(
  home: string,
  connectorId: string,
  runId: string,
): Promise<string> {
  await writeRawFile(home, connectorId, `${runId}/target.json`, "{}");
  const linkPath = rawPath(home, connectorId, runId, "linked");

  try {
    await symlink(rawPath(home, connectorId, runId, "target.json"), linkPath);
  } catch (error) {
    if (!isSymlinkPermissionError(error)) {
      throw error;
    }

    const targetDir = path.join(home, "outside-target");
    await mkdir(targetDir, { recursive: true });
    await symlink(targetDir, linkPath, "junction");
  }

  return `${runId}/linked`;
}

async function createSymlinkRawDir(
  home: string,
  connectorId: string,
): Promise<string> {
  const runId = "2026-07-21T000000Z";
  const targetDir = path.join(home, "outside-raw");
  const rawDir = rawPath(home, connectorId);

  await mkdir(path.join(targetDir, runId), { recursive: true });
  await writeFile(
    path.join(targetDir, runId, "outside.json"),
    "outside",
    "utf8",
  );
  await mkdir(path.dirname(rawDir), { recursive: true });

  try {
    await symlink(targetDir, rawDir, "dir");
  } catch (error) {
    if (!isSymlinkPermissionError(error)) {
      throw error;
    }

    await symlink(targetDir, rawDir, "junction");
  }

  return `${runId}/outside.json`;
}

function rawPath(
  home: string,
  connectorId: string,
  ...parts: string[]
): string {
  return path.join(
    home,
    ".openwiki",
    "connectors",
    connectorId,
    "raw",
    ...parts,
  );
}

function isSymlinkPermissionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ["EACCES", "ENOTSUP", "EPERM"].includes(
      String((error as NodeJS.ErrnoException).code),
    )
  );
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
