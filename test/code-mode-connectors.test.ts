import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/connectors/registry.ts", () => ({
  createConnectorRegistry: vi.fn(),
}));

vi.mock("../src/ingestion.ts", () => ({
  createConnectorSynthesisGuidance: vi.fn(
    (c: ConnectorRuntime) => `guidance:${c.displayName}`,
  ),
}));

import { runCodeModeConnectors } from "../src/code-mode.ts";
import { createConnectorRegistry } from "../src/connectors/registry.ts";
import type {
  ConnectorIngestResult,
  ConnectorRuntime,
} from "../src/connectors/types.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

function pullResult(
  overrides: Partial<ConnectorIngestResult> = {},
): ConnectorIngestResult {
  return {
    connectorId: "langsmith",
    message: "",
    rawFiles: ["/raw/langsmith/run-1/results.json"],
    runId: "run-1",
    statePath: "",
    status: "success",
    warnings: [],
    ...overrides,
  };
}

const succeeds: ConnectorRuntime["ingest"] = () =>
  Promise.resolve(pullResult());
const skips: ConnectorRuntime["ingest"] = () =>
  Promise.resolve(pullResult({ rawFiles: [], status: "skipped" }));

function connector(overrides: Partial<ConnectorRuntime>): ConnectorRuntime {
  return {
    backend: "direct-api",
    description: "",
    displayName: "",
    id: "langsmith",
    ingest: succeeds,
    mode: "personal",
    requiredEnv: [],
    supportsAgenticDiscovery: false,
    ...overrides,
  };
}

function registryOf(...connectors: ConnectorRuntime[]): void {
  const map: Record<string, ConnectorRuntime> = {};
  connectors.forEach((entry, index) => {
    map[`c-${index}`] = entry;
  });
  vi.mocked(createConnectorRegistry).mockReturnValue(map);
}

describe("runCodeModeConnectors", () => {
  test("returns the base message when no code connector produces evidence", async () => {
    registryOf(
      connector({ ingest: succeeds, mode: "personal" }),
      connector({ ingest: skips, mode: "code" }),
    );

    await expect(runCodeModeConnectors("/repo", "base")).resolves.toBe("base");
  });

  test("never ingests personal-mode connectors", async () => {
    const personalIngest = vi.fn(succeeds);
    registryOf(
      connector({ ingest: personalIngest, mode: "personal" }),
      connector({ ingest: skips, mode: "code" }),
    );

    await runCodeModeConnectors("/repo", "base");

    expect(personalIngest).not.toHaveBeenCalled();
  });

  test("appends the guidance of each code connector that produced evidence", async () => {
    registryOf(
      connector({ displayName: "A", ingest: succeeds, mode: "code" }),
      connector({ displayName: "B", ingest: succeeds, mode: "code" }),
    );

    await expect(runCodeModeConnectors("/repo", "base")).resolves.toBe(
      "base\n\nguidance:A\n\nguidance:B",
    );
  });

  test("returns just the guidance when there is no base message", async () => {
    registryOf(connector({ displayName: "A", ingest: succeeds, mode: "code" }));

    await expect(runCodeModeConnectors("/repo", undefined)).resolves.toBe(
      "guidance:A",
    );
  });

  test("passes repoRoot and a numeric window from .last-update.json to ingest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openwiki-codemode-"));
    tempRoots.push(root);
    await mkdir(path.join(root, "openwiki"), { recursive: true });
    await writeFile(
      path.join(root, "openwiki", ".last-update.json"),
      JSON.stringify({ updatedAt: "2026-07-20T00:00:00.000Z" }),
      "utf8",
    );
    const ingest = vi.fn(succeeds);
    registryOf(connector({ ingest, mode: "code" }));

    await runCodeModeConnectors(root, "base");

    const options = ingest.mock.calls[0]?.[0];
    expect(options?.repoRoot).toBe(root);
    expect(typeof options?.windowHours).toBe("number");
  });

  test("passes an undefined window when there is no .last-update.json (first run)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openwiki-codemode-"));
    tempRoots.push(root);
    const ingest = vi.fn(succeeds);
    registryOf(connector({ ingest, mode: "code" }));

    await runCodeModeConnectors(root, "base");

    const options = ingest.mock.calls[0]?.[0];
    expect(options?.repoRoot).toBe(root);
    expect(options?.windowHours).toBeUndefined();
  });
});
