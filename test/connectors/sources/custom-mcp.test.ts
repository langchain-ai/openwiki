import { describe, expect, test } from "vitest";
import {
  CONNECTOR_IDS,
  createConnectorRegistry,
  isConnectorId,
} from "../../../src/connectors/registry.ts";

describe("custom-mcp connector registration", () => {
  test("is a registered MCP personal connector", () => {
    expect(isConnectorId("custom-mcp")).toBe(true);
    expect(CONNECTOR_IDS).toContain("custom-mcp");

    const connector = createConnectorRegistry()["custom-mcp"];
    expect(connector).toMatchObject({
      backend: "mcp-stdio",
      displayName: "Custom MCP",
      id: "custom-mcp",
      mode: "personal",
      requiredEnv: [],
      supportsAgenticDiscovery: true,
    });
    expect(typeof connector.ingest).toBe("function");
  });
});
