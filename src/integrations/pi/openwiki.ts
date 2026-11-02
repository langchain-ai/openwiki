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

type JsonSchema = Record<string, unknown>;

type PiToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

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

type PiApi = {
  registerTool(tool: PiTool): void;
  on(event: "session_shutdown", handler: () => Promise<void>): void;
};

type Bridge = {
  client: Client;
  transport: StdioClientTransport;
};

const OPENWIKI_TOOLS = [
  {
    name: "openwiki_begin",
    label: "OpenWiki begin",
    description: "Start or resume an OpenWiki repository run.",
    parameters: z.toJSONSchema(BeginInput, { target: "draft-07" }),
    executionMode: "sequential",
  },
  {
    name: "openwiki_submit_plan",
    label: "OpenWiki submit plan",
    description: "Submit the final page plan for an OpenWiki run.",
    parameters: z.toJSONSchema(SubmitPlanInput, { target: "draft-07" }),
    executionMode: "sequential",
  },
  {
    name: "openwiki_next_page",
    label: "OpenWiki next page",
    description: "Get the next pending OpenWiki page job.",
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

let bridgePromise: Promise<Bridge> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
 * Builds the environment additions for the spawned CLI child.
 *
 * `startBridge` spawns the CLI with `process.execPath`. Under a plain Node host
 * that is the Node binary, but under an Electron host it is the Electron binary,
 * which runs the CLI as a Node process only when `ELECTRON_RUN_AS_NODE` is set.
 * A standalone Bun-compiled host (Pi built with `bun build --compile`) is the
 * same problem in another runtime: `process.execPath` is that executable, and it
 * runs its bundled entrypoint rather than the CLI script unless `BUN_BE_BUN=1`
 * (Bun >= 1.2.16) makes it behave as the Bun CLI.
 *
 * The SDK's default child environment is an allowlist (`HOME`, `LOGNAME`, `PATH`,
 * `SHELL`, `TERM`, `USER`) that drops either variable, so a host that already
 * exported one has to have it re-exported, and a host that never set it has to
 * have it supplied. Without it the child starts the host app instead of the stdio
 * server and exits, which the host reports as `MCP error -32000: Connection
 * closed`.
 *
 * @returns Environment additions for the child, or `undefined` to keep the SDK's
 * default environment for a plain Node host.
 */
function bridgeEnvironment(): Record<string, string> | undefined {
  const inheritedElectron = process.env.ELECTRON_RUN_AS_NODE;
  if (inheritedElectron) return { ELECTRON_RUN_AS_NODE: inheritedElectron };
  if (process.versions.electron) return { ELECTRON_RUN_AS_NODE: "1" };
  const inheritedBun = process.env.BUN_BE_BUN;
  if (inheritedBun) return { BUN_BE_BUN: inheritedBun };
  if (process.versions.bun) return { BUN_BE_BUN: "1" };
  return undefined;
}

async function startBridge(onclose: () => void): Promise<Bridge> {
  const cliPath = fileURLToPath(new URL("../../cli/cli.js", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "mcp", "--host", "pi"],
    stderr: "inherit",
    env: bridgeEnvironment(),
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

async function discardBridge(
  pending: Promise<Bridge>,
  failed: Bridge,
): Promise<void> {
  if (bridgePromise === pending) bridgePromise = undefined;
  await closeBridgeResources(failed);
}

export default function openwiki(pi: PiApi): void {
  for (const definition of OPENWIKI_TOOLS) {
    pi.registerTool({
      ...definition,
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
