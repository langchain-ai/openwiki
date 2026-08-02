import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { createClickUpConnector } from "../src/connectors/sources/clickup.ts";

vi.mock("../src/connectors/io.js", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../src/connectors/io.js")
  >();
  return {
    ...original,
    readConnectorConfig: vi.fn().mockResolvedValue({
      enabled: true,
      maxTasksPerList: 100,
      workspaceIds: [],
    }),
    readConnectorState: vi.fn().mockResolvedValue({ version: 1 }),
    writeConnectorState: vi.fn().mockResolvedValue(undefined),
    writeRawJson: vi.fn().mockResolvedValue("mock-path"),
  };
});

describe("ClickUp connector", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OPENWIKI_CLICKUP_API_TOKEN;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("definition", () => {
    const connector = createClickUpConnector();

    test("has correct id and display name", () => {
      expect(connector.id).toBe("clickup");
      expect(connector.displayName).toBe("ClickUp");
    });

    test("uses direct-api backend", () => {
      expect(connector.backend).toBe("direct-api");
    });

    test("requires OPENWIKI_CLICKUP_API_TOKEN env var", () => {
      expect(connector.requiredEnv).toEqual(["OPENWIKI_CLICKUP_API_TOKEN"]);
    });

    test("does not support agentic discovery", () => {
      expect(connector.supportsAgenticDiscovery).toBe(false);
    });

    test("has a description", () => {
      expect(typeof connector.description).toBe("string");
      expect(connector.description.length).toBeGreaterThan(0);
    });

    test("exposes an ingest function", () => {
      expect(typeof connector.ingest).toBe("function");
    });
  });

  describe("ingest", () => {
    test("returns error when API token is missing", async () => {
      const connector = createClickUpConnector();
      const result = await connector.ingest();

      expect(result.status).toBe("error");
      expect(result.connectorId).toBe("clickup");
      expect(result.message).toContain("OPENWIKI_CLICKUP_API_TOKEN");
    });
  });
});
