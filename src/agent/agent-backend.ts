import {
  CompositeBackend,
  FilesystemBackend,
  type FilesystemPermission,
  type GlobResult,
} from "deepagents";
import {
  openWikiConversationHistoryDir,
  openWikiSkillsDir,
} from "../config/openwiki-home.js";
import { OpenWikiLocalShellBackend } from "./docs-only-backend.js";

/**
 * DeepAgents' fixed history-offload mount.
 */
export const CONVERSATION_HISTORY_MOUNT = "/conversation_history/";

/** Maximum brace nesting accepted before a glob reaches recursive parsers. */
const MAX_GLOB_BRACE_NESTING = 100;

/**
 * Checks unescaped brace depth without interpreting the rest of glob syntax.
 */
function exceedsGlobBraceNesting(pattern: string): boolean {
  let braceDepth = 0;
  let escaped = false;

  for (const character of pattern) {
    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (character === "{") {
      braceDepth += 1;
      if (braceDepth > MAX_GLOB_BRACE_NESTING) return true;
    } else if (character === "}" && braceDepth > 0) {
      braceDepth -= 1;
    }
  }

  return false;
}

/**
 * Shared filesystem restrictions for native OpenWiki agents.
 */
export const AGENT_FILESYSTEM_PERMISSIONS: FilesystemPermission[] = [
  { operations: ["write"], paths: ["/skills/**"], mode: "deny" },
  {
    operations: ["write"],
    paths: [`${CONVERSATION_HISTORY_MOUNT}**`],
    mode: "deny",
  },
];

/**
 * Optional host directories mounted into an OpenWiki agent backend.
 */
interface AgentBackendMountOptions {
  /**
   * Directory used for DeepAgents conversation-history offload.
   */
  historyDir?: string;

  /**
   * Directory containing installed OpenWiki skills.
   */
  skillsDir?: string;
}

/**
 * Mounts generated docs, conversation history, and bundled skills for an agent.
 *
 * @param wikiBackend - Worker-specific repository or local-wiki backend.
 * @param options - Optional mount overrides used by tests and isolated hosts.
 * @returns Composite backend with OpenWiki's fixed virtual mounts.
 */
export function createAgentBackend(
  wikiBackend: OpenWikiLocalShellBackend,
  {
    historyDir = openWikiConversationHistoryDir,
    skillsDir = openWikiSkillsDir,
  }: AgentBackendMountOptions = {},
): CompositeBackend {
  return new OpenWikiCompositeBackend(wikiBackend, {
    [CONVERSATION_HISTORY_MOUNT]: new FilesystemBackend({
      rootDir: historyDir,
      virtualMode: true,
    }),
    "/skills/": new FilesystemBackend({
      rootDir: skillsDir,
      virtualMode: true,
    }),
  });
}

/**
 * Composite backend that converts a known upstream broad-glob overflow into a
 * bounded model-facing error.
 */
class OpenWikiCompositeBackend extends CompositeBackend {
  /**
   * Expands a glob while handling DeepAgents' recoverable recursion overflow.
   *
   * @param pattern - Glob pattern supplied by the worker.
   * @param path - Virtual search root.
   * @returns Normal glob results or a bounded retry instruction.
   */
  override async glob(pattern: string, path = "/"): Promise<GlobResult> {
    if (exceedsGlobBraceNesting(pattern)) {
      return {
        error:
          "Glob pattern nesting is too deep. Retry with a simpler pattern.",
      };
    }

    try {
      return await super.glob(pattern, path);
    } catch (error) {
      if (
        error instanceof RangeError &&
        error.message === "Maximum call stack size exceeded"
      ) {
        return {
          error:
            "Glob search was too broad. Retry with a narrower path or pattern.",
        };
      }
      throw error;
    }
  }
}
