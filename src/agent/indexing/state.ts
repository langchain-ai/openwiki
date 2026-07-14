import { ToolMessage } from "@langchain/core/messages";
import {
  Command,
  isCommand,
  ReducedValue,
  StateSchema,
} from "@langchain/langgraph";
import { createMiddleware } from "langchain";
import { z } from "zod";
import type { OpenWikiOutputMode } from "../types.js";
import { addFrontmatterWarning } from "./frontmatter-validator.js";
import { type IndexBackend, MUTATION_PATH_METADATA_KEY } from "./utils.js";

// Persists successful wiki mutations across tool calls in one agent run.

export function mergeEditedWikiPaths(
  current: string[],
  next: string[],
): string[] {
  return next.length === 0 ? [] : [...new Set([...current, ...next])];
}

export const OpenWikiIndexStateSchema = new StateSchema({
  editedWikiPaths: new ReducedValue(
    z.array(z.string()).default(() => []),
    {
      inputSchema: z.array(z.string()),
      reducer: mergeEditedWikiPaths,
    },
  ),
});

export type OpenWikiIndexState = typeof OpenWikiIndexStateSchema.State;

export function createOpenWikiIndexStateMiddleware(
  backend: IndexBackend,
  outputMode: OpenWikiOutputMode,
) {
  return createMiddleware({
    name: "OpenWikiIndexState",
    stateSchema: OpenWikiIndexStateSchema,
    beforeAgent: () => ({ editedWikiPaths: [] }),
    wrapToolCall: async (request, handler) => {
      const result = await handler(request);
      await addFrontmatterWarning(
        result,
        backend,
        outputMode,
        request.toolCall.name,
      );
      return addEditedPathUpdate(result);
    },
  });
}

export function addEditedPathUpdate(result: ToolMessage | Command) {
  const mutationPath = findMutationPath(result);
  if (!mutationPath) return result;

  if (isCommand(result)) {
    result.update = Array.isArray(result.update)
      ? [...result.update, ["editedWikiPaths", [mutationPath]]]
      : { ...result.update, editedWikiPaths: [mutationPath] };
    return result;
  }

  return new Command({
    update: { editedWikiPaths: [mutationPath], messages: [result] },
  });
}

function findMutationPath(result: ToolMessage | Command): string | null {
  const messages = isCommand(result)
    ? Array.isArray(result.update)
      ? result.update.find(([key]) => key === "messages")?.[1]
      : result.update?.messages
    : [result];

  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    if (ToolMessage.isInstance(message)) {
      const path = message.metadata?.[MUTATION_PATH_METADATA_KEY];
      if (typeof path === "string") return path;
    }
  }
  return null;
}
