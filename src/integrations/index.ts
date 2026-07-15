import {
  writeClaudeIntegration,
  type ClaudeIntegrationResult,
} from "./claude.js";

export type IntegrationWriter = (
  targetDir: string,
) => Promise<ClaudeIntegrationResult>;

// Registry of host agents OpenWiki can export skills for. Add new agents here to
// make `openwiki integration <agent>` recognize and dispatch them.
const INTEGRATION_WRITERS: Record<string, IntegrationWriter> = {
  claude: writeClaudeIntegration,
};

export function supportedIntegrationAgents(): string[] {
  return Object.keys(INTEGRATION_WRITERS);
}

export function isSupportedIntegrationAgent(agent: string): boolean {
  return Object.prototype.hasOwnProperty.call(INTEGRATION_WRITERS, agent);
}

export function getIntegrationWriter(
  agent: string,
): IntegrationWriter | undefined {
  return INTEGRATION_WRITERS[agent];
}

export { writeClaudeIntegration, type ClaudeIntegrationResult };
