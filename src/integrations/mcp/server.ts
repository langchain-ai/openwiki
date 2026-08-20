import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { OPENWIKI_VERSION } from "../../version.js";
import { HostIntegrationError } from "../core/errors.js";
import type { ProtocolTool } from "../core/protocol.js";

/**
 * Host guidance advertised during MCP initialization.
 */
const INSTRUCTIONS = `OpenWiki exposes deterministic lifecycle bookends.
Resolve the absolute Git top-level, then call openwiki_begin with that root
before investigating or authoring. Use the host's native repository tools to
inspect source code and author wiki pages in the middle.
Call openwiki_finish after authoring. If the run cannot be completed, leave it
interrupted; a later begin supersedes it. Do not directly edit OpenWiki-owned
indexes, logs, provenance, run metadata, setup blocks, or scheduled workflows.
The host may author the temporary openwiki/_plan.md and openwiki/_skeleton.md
required by its installed workflow; finalization removes those files.`;

/**
 * Minimal lifecycle capability required by the MCP transport adapter.
 */
export interface HostLifecycleToolProvider {
  /**
   * Returns the complete transport-neutral lifecycle tool set.
   *
   * @returns Tools to register with the MCP server.
   */
  tools(): readonly ProtocolTool[];
}

/**
 * Creates the thin MCP adapter over a transport-neutral lifecycle provider.
 *
 * @param provider - Rootless lifecycle tool provider.
 * @returns Unconnected MCP server exposing the provider's tools.
 */
export function createOpenWikiMcpServer(
  provider: HostLifecycleToolProvider,
): McpServer {
  const server = new McpServer(
    { name: "openwiki", version: OPENWIKI_VERSION },
    { instructions: INSTRUCTIONS },
  );

  for (const tool of provider.tools()) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.schema,
      },
      async (input): Promise<CallToolResult> => executeTool(tool, input),
    );
  }

  return server;
}

/**
 * Executes one validated lifecycle tool and bounds transport-visible errors.
 *
 * @param tool - Registered transport-neutral lifecycle tool.
 * @param input - Input validated by the MCP SDK against the tool schema.
 * @returns MCP-compatible success or error content.
 */
async function executeTool(
  tool: ProtocolTool,
  input: unknown,
): Promise<CallToolResult> {
  try {
    const result = await tool.handle(input);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: isRecord(result) ? result : { result },
    };
  } catch (error) {
    if (error instanceof HostIntegrationError) {
      return toolError(`${error.code}: ${error.message}`);
    }

    process.stderr.write("OpenWiki MCP operation failed.\n");
    return toolError("OpenWiki MCP operation failed.");
  }
}

/**
 * Formats a bounded MCP tool error without exposing unknown exception data.
 *
 * @param message - Safe error text.
 * @returns MCP-compatible error result.
 */
function toolError(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

/**
 * Narrows an unknown tool result to a non-array object.
 *
 * @param value - Unknown tool result.
 * @returns Whether the value can be emitted as structured MCP content.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
