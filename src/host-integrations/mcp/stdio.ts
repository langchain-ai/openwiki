import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HostSessionManager } from "../core/session-manager.js";
import { createOpenWikiMcpServer } from "./server.js";

/**
 * Inputs required to start the repository-rooted MCP process.
 */
export interface RunOpenWikiMcpOptions {
  /**
   * Repository root fixed for the lifetime of the process.
   */
  root: string;

  /**
   * Stable host identifier written to run metadata.
   */
  host: string;
}

/**
 * Starts OpenWiki's local stdio MCP server without writing to stdout.
 *
 * @param options - Repository root and host identifier.
 */
export async function runOpenWikiMcp(
  options: RunOpenWikiMcpOptions,
): Promise<void> {
  const manager = await HostSessionManager.create(options);
  const server = createOpenWikiMcpServer(manager);
  await server.connect(new StdioServerTransport());
}
