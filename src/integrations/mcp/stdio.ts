import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HostSessionManager } from "../core/session-manager.js";
import { createOpenWikiMcpServer } from "./server.js";

/**
 * Inputs required to start the rootless MCP process.
 */
export interface RunOpenWikiMcpOptions {
  /**
   * Stable host identifier written to run metadata.
   */
  host: string;

  /**
   * Stable OKF producer for host-authored page bodies; the host's MCP client
   * version is appended as `<producer>/<version>` when it reports one.
   *
   * @default host
   */
  producerActor?: string;
}

/**
 * Creates the unconnected host MCP server over one session manager.
 *
 * @param options - Host identifier and producer used for run metadata.
 * @returns MCP server whose runs record the connected host's version.
 */
export function createOpenWikiHostServer(
  options: RunOpenWikiMcpOptions,
): McpServer {
  // The host reports its version in the MCP initialize handshake, after the
  // manager exists, so the manager reads it lazily when a run begins.
  const server: McpServer = createOpenWikiMcpServer(
    HostSessionManager.create({
      ...options,
      producerVersion: () => server.server.getClientVersion()?.version,
    }),
  );
  return server;
}

/**
 * Starts OpenWiki's local stdio MCP server without writing to stdout.
 *
 * @param options - Host identifier used for run metadata.
 */
export async function runOpenWikiMcp(
  options: RunOpenWikiMcpOptions,
): Promise<void> {
  await createOpenWikiHostServer(options).connect(new StdioServerTransport());
}
