import {
  DynamicStructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";
import type { OpenWikiOutputMode } from "../agent/types.js";
import {
  resolveWikiRootFromOutputMode,
  virtualRootForOutputMode,
} from "./resolve-wiki-root.js";
import { searchWiki } from "./search-wiki.js";

export function createWikiSearchTool(options: {
  cwd: string;
  outputMode: OpenWikiOutputMode;
}): StructuredToolInterface {
  const rootDir = resolveWikiRootFromOutputMode(
    options.outputMode,
    options.cwd,
  );
  const virtualRoot = virtualRootForOutputMode(options.outputMode);

  return new DynamicStructuredTool({
    name: "openwiki_search_wiki",
    description:
      "Full-text search over the OpenWiki markdown wiki. Use this before broad ls/grep/read_file crawls when looking for existing wiki knowledge. Returns ranked hits with virtualPath, line, and snippet. Then read only the best matching pages.",
    schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (keywords or a short phrase).",
        },
        maxResults: {
          type: "number",
          description: "Maximum hits to return (default 20, max 100).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    } as const,
    func: async (input) => {
      const query = getStringInput(input, "query");
      const maxResults = getNumberInput(input, "maxResults") ?? undefined;
      const hits = await searchWiki({
        rootDir,
        query,
        virtualRoot,
        maxResults,
      });

      return JSON.stringify(
        {
          query,
          rootDirNote:
            options.outputMode === "local-wiki"
              ? "Searched the personal brain wiki (virtual root /)."
              : "Searched the repository openwiki/ docs (virtual root /openwiki/).",
          hitCount: hits.length,
          hits,
        },
        null,
        2,
      );
    },
  });
}

function getStringInput(input: unknown, key: string): string {
  if (!isRecord(input) || typeof input[key] !== "string") {
    throw new Error(`Missing string input: ${key}`);
  }
  return input[key];
}

function getNumberInput(input: unknown, key: string): number | null {
  if (!isRecord(input) || input[key] === undefined) {
    return null;
  }
  if (typeof input[key] !== "number") {
    throw new Error(`Expected number input: ${key}`);
  }
  return input[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
