import type {
  HostMcpServerCommand,
  HostTarget,
  HostTargetId,
} from "./types.js";

/**
 * Complete immutable registry of supported host installation targets.
 */
export const HOST_TARGETS = {
  codex: {
    id: "codex",
    displayName: "Codex",
    producerActor: "codex",
    user: {
      skillDirectory: ".agents/skills/openwiki",
      mcpConfig: {
        kind: "codex-toml",
        relativePath: ".codex/config.toml",
      },
    },
    project: {
      skillDirectory: ".agents/skills/openwiki",
      mcpConfig: {
        kind: "codex-toml",
        relativePath: ".codex/config.toml",
      },
    },
    documentationUrl: "https://learn.chatgpt.com/docs/extend/mcp",
  },
  claude: {
    id: "claude",
    displayName: "Claude Code",
    producerActor: "claude-code",
    user: {
      skillDirectory: ".claude/skills/openwiki",
      mcpConfig: { kind: "json", relativePath: ".claude.json" },
    },
    project: {
      skillDirectory: ".claude/skills/openwiki",
      mcpConfig: { kind: "json", relativePath: ".mcp.json" },
    },
    documentationUrl: "https://docs.anthropic.com/en/docs/claude-code/mcp",
  },
  opencode: {
    id: "opencode",
    displayName: "OpenCode",
    producerActor: "opencode",
    user: {
      skillDirectory: ".config/opencode/skills/openwiki",
      mcpConfig: {
        kind: "opencode-json",
        relativePath: ".config/opencode/opencode.jsonc",
      },
    },
    project: {
      skillDirectory: ".opencode/skills/openwiki",
      mcpConfig: {
        kind: "opencode-json",
        relativePath: "opencode.jsonc",
      },
    },
    documentationUrl: "https://opencode.ai/docs/mcp-servers/",
  },
} as const satisfies Record<HostTargetId, HostTarget>;

/**
 * Resolves a host registry entry from untrusted CLI text.
 *
 * @param id - Candidate host identifier.
 * @returns Matching host target, or `undefined` when unsupported.
 */
export function getHostTarget(id: string): HostTarget | undefined {
  return HOST_TARGETS[id as HostTargetId];
}

/**
 * Lists supported host targets in registry order.
 *
 * @returns Independent array of host registry entries.
 */
export function listHostTargets(): HostTarget[] {
  return Object.values(HOST_TARGETS);
}

/**
 * Creates the default managed MCP command for one host.
 *
 * @param target - Stable host identifier passed to the MCP process.
 * @returns Portable executable invocation used by published installations.
 */
export function defaultMcpServerCommand(
  target: HostTargetId,
): HostMcpServerCommand {
  return {
    command: "openwiki",
    args: ["mcp", "--host", target],
  };
}
