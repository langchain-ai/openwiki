import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import {
  deriveIndexTitle,
  getParentIndexPath,
  type IndexBackend,
  parseIndexMetadata,
  readTextIfExists,
  renderIndex,
  validateIndexPath,
} from "./index-utils.js";
import type { OpenWikiOutputMode } from "./types.js";

export function createOrUpdateIndexTool(
  backend: IndexBackend,
  outputMode: OpenWikiOutputMode,
): StructuredToolInterface {
  return tool(
    async ({ path, description }) =>
      JSON.stringify(
        await createOrUpdateIndex(backend, outputMode, path, description),
        null,
        2,
      ),
    {
      name: "openwiki_create_or_update_index",
      description:
        "Deterministically create/update one pending index.md and its existing parent. A supplied description replaces the directory description; omission preserves it.",
      schema: z.object({
        description: z.string().min(1).optional(),
        path: z.string().min(1),
      }),
    },
  );
}

export async function createOrUpdateIndex(
  backend: IndexBackend,
  outputMode: OpenWikiOutputMode,
  requestedPath: string,
  requestedDescription?: string,
): Promise<{ updated: string[] }> {
  const indexPath = validateIndexPath(requestedPath, outputMode);
  const updated: string[] = [];
  await synchronize(
    backend,
    outputMode,
    indexPath,
    requestedDescription,
    updated,
  );

  const parentPath = getParentIndexPath(indexPath, outputMode);
  if (parentPath && (await readTextIfExists(backend, parentPath))) {
    await synchronize(backend, outputMode, parentPath, undefined, updated);
  }
  return { updated };
}

async function synchronize(
  backend: IndexBackend,
  outputMode: OpenWikiOutputMode,
  indexPath: string,
  requestedDescription: string | undefined,
  updated: string[],
): Promise<void> {
  const existing = await readTextIfExists(backend, indexPath);
  const metadata = existing ? parseIndexMetadata(existing) : {};
  const description = requestedDescription?.trim() || metadata.description;
  if (!description)
    throw new Error(`A description is required for ${indexPath}.`);

  const rendered = await renderIndex(backend, indexPath, {
    description,
    title: metadata.title ?? deriveIndexTitle(indexPath, outputMode),
  });
  if (rendered === existing) return;

  const result = existing
    ? await backend.edit(indexPath, existing, rendered)
    : await backend.write(indexPath, rendered);
  if (result.error)
    throw new Error(`Unable to write ${indexPath}: ${result.error}`);
  updated.push(indexPath);
}
