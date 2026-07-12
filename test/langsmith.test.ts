import { describe, expect, test } from "vitest";

import { getAuthProvider } from "../src/auth/providers.js";
import { isMcpConnectorId } from "../src/connectors/mcp-runtime.js";
import {
  CONNECTOR_IDS,
  createConnectorRegistry,
} from "../src/connectors/registry.js";

describe("LangSmith Remote MCP connector", () => {
  test("uses OAuth dynamic registration against the hosted MCP resource", () => {
    expect(getAuthProvider("langsmith")).toMatchObject({
      clientAuth: "none",
      mcpResourceUrl: "https://api.smith.langchain.com/mcp",
      tokenMapping: {
        accessTokenEnvKey: "OPENWIKI_LANGSMITH_MCP_ACCESS_TOKEN",
        clientIdEnvKey: "OPENWIKI_LANGSMITH_MCP_CLIENT_ID",
        refreshTokenEnvKey: "OPENWIKI_LANGSMITH_MCP_REFRESH_TOKEN",
      },
    });
  });

  test("is registered as an OAuth-backed MCP connector", () => {
    expect(CONNECTOR_IDS).toContain("langsmith");
    expect(isMcpConnectorId("langsmith")).toBe(true);
    expect(createConnectorRegistry().langsmith).toMatchObject({
      id: "langsmith",
      requiredEnv: ["OPENWIKI_LANGSMITH_MCP_ACCESS_TOKEN"],
      supportsAgenticDiscovery: true,
    });
  });
});
