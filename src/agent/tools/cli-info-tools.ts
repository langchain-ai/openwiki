import {
  DynamicStructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";
import { getHelpText } from "../../commands.js";

/**
 * Builds the CLI information tools. `openwiki_cli_help` returns the formatted
 * CLI help text directly from {@link getHelpText}, with no shell execution.
 */
export function createCliInfoTools(): StructuredToolInterface[] {
  return [
    new DynamicStructuredTool({
      name: "openwiki_cli_help",
      description:
        "Return the OpenWiki CLI help text (usage, commands, options, and examples). Takes no input.",
      schema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      } as const,
      func: async () => getHelpText(),
    }),
  ];
}
