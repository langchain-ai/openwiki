import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/connectors/registry.ts", () => ({
  createConnectorRegistry: vi.fn(),
}));

import { runCodeModeConnectors } from "../src/code-mode.ts";
import { createConnectorRegistry } from "../src/connectors/registry.ts";
import type { ConnectorRuntime } from "../src/connectors/types.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

function connector(overrides: Partial<ConnectorRuntime>): ConnectorRuntime {
  return {
    backend: "direct-api",
    description: "",
    displayName: "",
    id: "langsmith",
    ingest: () => Promise.resolve({} as never),
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
  test("returns the base message when nothing contributes", async () => {
    registryOf(
      connector({ mode: "personal" }),
      connector({
        buildCodeModeGuidance: () => Promise.resolve(undefined),
        mode: "code",
      }),
    );

    await expect(runCodeModeConnectors("/repo", "base")).resolves.toBe("base");
  });

  test("skips personal-mode connectors and code connectors without the hook", async () => {
    const personalHook = vi.fn(() => Promise.resolve("nope"));
    registryOf(
      connector({ buildCodeModeGuidance: personalHook, mode: "personal" }),
      connector({ mode: "code" }),
    );

    await expect(runCodeModeConnectors("/repo", "base")).resolves.toBe("base");
    expect(personalHook).not.toHaveBeenCalled();
  });

  test("appends each contributing code-mode connector's guidance", async () => {
    registryOf(
      connector({
        buildCodeModeGuidance: () => Promise.resolve("block-A"),
        mode: "code",
      }),
      connector({
        buildCodeModeGuidance: () => Promise.resolve("block-B"),
        mode: "code",
      }),
    );

    await expect(runCodeModeConnectors("/repo", "base")).resolves.toBe(
      "base\n\nblock-A\n\nblock-B",
    );
  });

  test("returns just the guidance when there is no base message", async () => {
    registryOf(
      connector({
        buildCodeModeGuidance: () => Promise.resolve("block-A"),
        mode: "code",
      }),
    );

    await expect(runCodeModeConnectors("/repo", undefined)).resolves.toBe(
      "block-A",
    );
  });

  test("passes the .last-update.json timestamp as the since window", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openwiki-codemode-"));
    tempRoots.push(root);
    await mkdir(path.join(root, "openwiki"), { recursive: true });
    await writeFile(
      path.join(root, "openwiki", ".last-update.json"),
      JSON.stringify({ updatedAt: "2026-07-21T00:00:00.000Z" }),
      "utf8",
    );
    const hook = vi.fn(() => Promise.resolve("block"));
    registryOf(connector({ buildCodeModeGuidance: hook, mode: "code" }));

    await runCodeModeConnectors(root, "base");

    expect(hook).toHaveBeenCalledWith(root, "2026-07-21T00:00:00.000Z");
  });

  test("passes undefined since when there is no .last-update.json (first run)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openwiki-codemode-"));
    tempRoots.push(root);
    const hook = vi.fn(() => Promise.resolve("block"));
    registryOf(connector({ buildCodeModeGuidance: hook, mode: "code" }));

    await runCodeModeConnectors(root, "base");

    expect(hook).toHaveBeenCalledWith(root, undefined);
  });
});
