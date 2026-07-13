import { ToolMessage } from "@langchain/core/messages";
import {
  Command,
  isCommand,
  ReducedValue,
  StateSchema,
} from "@langchain/langgraph";
import { createMiddleware } from "langchain";
import { z } from "zod";

export const MUTATION_PATH_METADATA_KEY = "openwikiMutationPath";

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

export function createOpenWikiIndexStateMiddleware() {
  return createMiddleware({
    name: "OpenWikiIndexState",
    stateSchema: OpenWikiIndexStateSchema,
    beforeAgent: () => ({ editedWikiPaths: [] }),
    wrapToolCall: async (request, handler) =>
      addEditedPathUpdate(await handler(request)),
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
