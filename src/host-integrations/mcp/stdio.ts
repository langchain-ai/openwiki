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
   * Stable OKF producer actor for host-authored page bodies.
   *
   * @default host
   */
  producerActor?: string;
}

/**
 * Starts OpenWiki's local stdio MCP server without writing to stdout.
 *
 * @param options - Host identifier used for run metadata.
 */
export async function runOpenWikiMcp(
  options: RunOpenWikiMcpOptions,
): Promise<void> {
  const manager = HostSessionManager.create(options);
  const server = createOpenWikiMcpServer(manager);
  await server.connect(new StdioServerTransport());
}
