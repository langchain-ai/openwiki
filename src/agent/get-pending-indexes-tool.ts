import {
  tool,
  type StructuredToolInterface,
  type ToolRuntime,
} from "@langchain/core/tools";
import { z } from "zod";
import type { OpenWikiIndexState } from "./index-state.js";
import {
  deriveIndexTitle,
  getPendingIndexPaths,
  type IndexBackend,
  parseIndexMetadata,
  type PendingIndex,
  readTextIfExists,
  renderIndex,
} from "./index-utils.js";
import type { OpenWikiOutputMode } from "./types.js";

export function createGetPendingIndexesTool(
  backend: IndexBackend,
  outputMode: OpenWikiOutputMode,
): StructuredToolInterface {
  return tool(
    async (_input, runtime: ToolRuntime<OpenWikiIndexState>) =>
      JSON.stringify(
        await findPendingIndexes(
          backend,
          outputMode,
          runtime.state.editedWikiPaths,
        ),
        null,
        2,
      ),
    {
      name: "openwiki_get_pending_indexes",
      description:
        "Return only index.md files that need creation or changes after this run's wiki writes/edits, including path, existence, and current description when set.",
      schema: z.object({}),
    },
  );
}

export async function findPendingIndexes(
  backend: IndexBackend,
  outputMode: OpenWikiOutputMode,
  editedWikiPaths: string[],
): Promise<PendingIndex[]> {
  const pending: PendingIndex[] = [];

  for (const indexPath of getPendingIndexPaths(editedWikiPaths, outputMode)) {
    const content = await readTextIfExists(backend, indexPath);
    const metadata = content ? parseIndexMetadata(content) : {};

    if (content && metadata.description) {
      try {
        const rendered = await renderIndex(backend, indexPath, {
          description: metadata.description,
          title: metadata.title ?? deriveIndexTitle(indexPath, outputMode),
        });
        if (rendered === content) continue;
      } catch {
        // A blocked parent remains pending until deeper indexes are complete.
      }
    }

    pending.push({
      ...(metadata.description ? { description: metadata.description } : {}),
      exists: content !== null,
      path: indexPath,
    });
  }

  return pending;
}
