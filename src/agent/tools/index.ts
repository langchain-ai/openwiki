import type { StructuredToolInterface } from "@langchain/core/tools";
import { createOpenWikiConnectorTools } from "../../connectors/tools.js";
import type { OpenWikiCommand, OpenWikiOutputMode } from "../types.js";
import { createCliInfoTools } from "./cli-info-tools.js";
import { createGitReadOnlyTools } from "./git-tools.js";
import { createRepositoryDiscoveryTools } from "./repo-tools.js";

export type ToolContext = {
  cwd: string;
  outputMode: OpenWikiOutputMode;
  command: OpenWikiCommand;
};

/**
 * Composes the tool set exposed to an OpenWiki agent run. Connector tools and
 * the CLI help tool are available in every mode. Repository runs additionally
 * get the structured read-only git tools and the repository file discovery
 * tool. No generic shell execute tool is ever included here.
 */
export function buildOpenWikiTools(
  context: ToolContext,
): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = [
    ...createOpenWikiConnectorTools(),
    ...createCliInfoTools(),
  ];

  if (context.outputMode === "repository") {
    tools.push(...createGitReadOnlyTools(context));
    tools.push(...createRepositoryDiscoveryTools(context));
  }

  return tools;
}
