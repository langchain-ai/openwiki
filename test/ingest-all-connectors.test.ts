import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  ConnectorIngestResult,
  ConnectorRuntime,
} from "../src/connectors/types.ts";

// `openwiki_ingest_all_connectors` must isolate per-connector failures: one
// connector that throws should not discard the results of connectors that
// succeeded (issue #412). We mock the registry so the tool runs against two
// fake connectors — one that resolves, one that rejects — and assert the tool
// still returns both outcomes.

const throwingConnector: ConnectorRuntime = {
  backend: "direct-api",
  description: "always throws",
  displayName: "Boom",
  id: "x",
  ingest: () => Promise.reject(new Error("token expired")),
  requiredEnv: [],
  supportsAgenticDiscovery: false,
};

const successResult: ConnectorIngestResult = {
  connectorId: "hackernews",
  message: "ok",
  rawFiles: ["run/manifest.json"],
  runId: "run",
  statePath: "~/.openwiki/connectors/hackernews/state.json",
  status: "success",
  warnings: [],
};

const succeedingConnector: ConnectorRuntime = {
  backend: "direct-api",
  description: "always succeeds",
  displayName: "Hacker News",
  id: "hackernews",
  ingest: () => Promise.resolve(successResult),
  requiredEnv: [],
  supportsAgenticDiscovery: false,
};

vi.mock("../src/connectors/registry.ts", () => ({
  createConnectorRegistry: () => ({
    hackernews: succeedingConnector,
    x: throwingConnector,
  }),
  isConnectorId: (value: string) => value === "x" || value === "hackernews",
}));

afterEach(() => {
  vi.resetModules();
});

type IngestAllOutput = { results: ConnectorIngestResult[] };

async function runIngestAllTool(): Promise<IngestAllOutput> {
  const { createOpenWikiConnectorTools } =
    await import("../src/connectors/tools.ts");
  const tool = createOpenWikiConnectorTools().find(
    (t) => t.name === "openwiki_ingest_all_connectors",
  );
  expect(tool).toBeDefined();
  const raw = (await tool?.invoke({})) as string;
  return JSON.parse(raw) as IngestAllOutput;
}

describe("openwiki_ingest_all_connectors isolates failures", () => {
  test("a throwing connector does not discard a succeeding connector's result", async () => {
    const output = await runIngestAllTool();

    expect(output.results).toHaveLength(2);

    const success = output.results.find((r) => r.connectorId === "hackernews");
    expect(success?.status).toBe("success");
    expect(success?.rawFiles).toEqual(["run/manifest.json"]);

    const failure = output.results.find((r) => r.connectorId === "x");
    expect(failure?.status).toBe("error");
    expect(failure?.message).toContain("token expired");
    expect(failure?.warnings).toContain("token expired");
  });
});
