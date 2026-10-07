import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  BeginInput,
  InspectPageClaimsInput,
  NextPageInput,
  RunInput,
  SubmitPageInput,
  SubmitPlanInput,
} from "../core/protocol.js";
import { OPENWIKI_VERSION } from "../../version.js";

/**
 * JSON Schema object accepted by Pi tool registration.
 */
type JsonSchema = Record<string, unknown>;

/**
 * Pi-compatible result returned from one bridged MCP tool call.
 */
type PiToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

/**
 * Sequential OpenWiki tool shape registered with Pi.
 */
type PiTool = {
  name: string;
  label: string;
  description: string;
  parameters: JsonSchema;
  executionMode: "sequential";
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<PiToolResult>;
};

/**
 * Minimal Pi extension API consumed by OpenWiki.
 */
type PiApi = {
  registerTool(tool: PiTool): void;
  on(event: "session_shutdown", handler: () => Promise<void>): void;
};

/**
 * Connected MCP client and transport owned by the Pi extension.
 */
type Bridge = {
  client: Client;
  transport: StdioClientTransport;
};

/**
 * Canonical lifecycle tools exposed through the native Pi extension.
 */
const OPENWIKI_TOOLS = [
  {
    name: "openwiki_begin",
    label: "OpenWiki begin",
    description:
      "Start or resume an OpenWiki repository run and return its actual wikiDirectory.",
    parameters: z.toJSONSchema(BeginInput, { target: "draft-07" }),
    executionMode: "sequential",
  },
  {
    name: "openwiki_submit_plan",
    label: "OpenWiki submit plan",
    description:
      "Submit the final page plan using actual paths below the wikiDirectory returned by begin.",
    parameters: z.toJSONSchema(SubmitPlanInput, { target: "draft-07" }),
    executionMode: "sequential",
  },
  {
    name: "openwiki_next_page",
    label: "OpenWiki next page",
    description: "Get the next pending OpenWiki page job and actual path.",
    parameters: z.toJSONSchema(NextPageInput, { target: "draft-07" }),
    executionMode: "sequential",
  },
  {
    name: "openwiki_inspect_page_claims",
    label: "OpenWiki inspect page claims",
    description: "Inspect all current Claims for the pending OpenWiki page.",
    parameters: z.toJSONSchema(InspectPageClaimsInput, { target: "draft-07" }),
    executionMode: "sequential",
  },
  {
    name: "openwiki_submit_page",
    label: "OpenWiki submit page",
    description: "Submit sparse Claim decisions for the current OpenWiki page.",
    parameters: z.toJSONSchema(SubmitPageInput, { target: "draft-07" }),
    executionMode: "sequential",
  },
  {
    name: "openwiki_finish",
    label: "OpenWiki finish",
    description: "Finalize an OpenWiki repository run.",
    parameters: z.toJSONSchema(RunInput, { target: "draft-07" }),
    executionMode: "sequential",
  },
] satisfies Omit<PiTool, "execute">[];

/**
 * Shared lazy bridge promise for the current Pi session.
 */
let bridgePromise: Promise<Bridge> | undefined;

/**
 * Tests whether an unknown value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Converts one MCP result into Pi's text-and-details result format.
 */
function toolResultText(result: {
  content?: readonly unknown[];
  structuredContent?: unknown;
}): string {
  const text = (result.content ?? [])
    .filter(
      (item): item is { type: "text"; text: string } =>
        isRecord(item) && item.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
  return text || JSON.stringify(result.structuredContent ?? result);
}

/**
 * Starts and connects the local OpenWiki MCP subprocess.
 */
async function startBridge(onclose: () => void): Promise<Bridge> {
  const cliPath = fileURLToPath(new URL("../../cli/cli.js", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "mcp", "--host", "pi"],
    stderr: "inherit",
  });
  const client = new Client(
    { name: "openwiki-pi", version: OPENWIKI_VERSION },
    { capabilities: {} },
  );
  const bridge: Bridge = { client, transport };
  try {
    await client.connect(transport);
    const protocolOnclose = transport.onclose;
    transport.onclose = () => {
      protocolOnclose?.();
      onclose();
    };
    return bridge;
  } catch (error) {
    await closeBridgeResources(bridge);
    throw error;
  }
}

/**
 * Returns the shared bridge, creating it lazily when needed.
 */
function bridge(): Promise<Bridge> {
  if (!bridgePromise) {
    const pending = startBridge(() => {
      if (bridgePromise === managed) bridgePromise = undefined;
    });
    const managed = pending.catch((error: unknown) => {
      if (bridgePromise === managed) bridgePromise = undefined;
      throw error;
    });
    bridgePromise = managed;
  }
  return bridgePromise;
}

/**
 * Closes both resources owned by one connected bridge.
 */
async function closeBridgeResources(bridge: Bridge): Promise<void> {
  try {
    await bridge.client.close();
  } catch {
    try {
      await bridge.transport.close();
    } catch {
      // The child may have already exited.
    }
  }
}

/**
 * Closes and clears the current shared bridge.
 */
async function closeBridge(): Promise<void> {
  const pending = bridgePromise;
  bridgePromise = undefined;
  if (!pending) return;
  try {
    await closeBridgeResources(await pending);
  } catch {
    // The child may have exited before the host emitted session_shutdown.
  }
}

/**
 * Discards a failed bridge only when it is still the shared instance.
 */
async function discardBridge(
  pending: Promise<Bridge>,
  failed: Bridge,
): Promise<void> {
  if (bridgePromise === pending) bridgePromise = undefined;
  await closeBridgeResources(failed);
}

/**
 * Registers OpenWiki lifecycle tools and shutdown cleanup with Pi.
 */
export default function openwiki(pi: PiApi): void {
  for (const definition of OPENWIKI_TOOLS) {
    pi.registerTool({
      ...definition,
      /**
       * Executes one Pi tool call through the shared MCP bridge.
       */
      async execute(_toolCallId, params, signal) {
        const input = isRecord(params) ? params : {};
        const pendingBridge = bridge();
        const activeBridge = await pendingBridge;
        let result;
        try {
          result = await activeBridge.client.callTool(
            {
              name: definition.name,
              arguments: input,
            },
            undefined,
            signal ? { signal } : undefined,
          );
        } catch (error) {
          await discardBridge(pendingBridge, activeBridge);
          throw error;
        }
        const toolCallResult = result as {
          content?: readonly unknown[];
          structuredContent?: unknown;
          isError?: boolean;
        };
        const text = toolResultText(toolCallResult);
        if (toolCallResult.isError) throw new Error(text);
        return {
          content: [{ type: "text", text }],
          details: toolCallResult.structuredContent ?? result,
        };
      },
    });
  }

  pi.on("session_shutdown", closeBridge);
}
