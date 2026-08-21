import { ToolMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import { isGroundedWikiPage } from "./paths.js";
import { ClaimSession } from "./session.js";

/**
 * Creates middleware that adds page-local Claims debt to successful reads.
 *
 * The note exists only in the tool result presented to the model; the backend
 * content and generated Markdown remain unchanged.
 *
 * @param session - Run-scoped Claims state used to look up lazy issues.
 * @returns Middleware wrapping repository filesystem reads.
 */
export function createClaimsReadNoteMiddleware(session: ClaimSession) {
  return createMiddleware({
    name: "OpenWikiClaimsReadNoteMiddleware",
    wrapToolCall: async (request, handler) => {
      const requestedPath = getRequestedPath(request.toolCall.args);
      const isPageRead =
        request.toolCall.name === "read_file" &&
        requestedPath !== undefined &&
        isGroundedWikiPage(requestedPath);
      const result = await handler(request);
      if (!isPageRead) {
        return result;
      }
      const note = session.getReadNote(requestedPath);
      if (!note) {
        return result;
      }
      for (const message of getToolMessages(result)) {
        appendReadNote(message, note);
      }
      return result;
    },
  });
}

/**
 * Appends a Claims note without changing the shape of the tool result.
 *
 * DeepAgents filesystem reads use structured text blocks, while direct tool
 * results may still use plain strings. Supporting both shapes ensures the note
 * reaches the model in production as well as in lightweight test harnesses.
 * Failed reads are left untouched.
 *
 * @param message - Filesystem tool result to decorate.
 * @param note - Non-persisted page-local Claims guidance.
 */
function appendReadNote(message: ToolMessage, note: string): void {
  if (message.status === "error") {
    return;
  }
  if (typeof message.content === "string") {
    message.content = `${message.content}\n\n${note}`;
    return;
  }
  message.content = [...message.content, { type: "text", text: `\n\n${note}` }];
}

/**
 * Reads a DeepAgents filesystem path from normalized or compatibility arguments.
 *
 * @param input - Unknown tool-call argument object.
 * @returns Requested path, or `undefined` for non-filesystem arguments.
 */
function getRequestedPath(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const candidate = record.file_path ?? record.path;
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * Extracts ToolMessages from direct and Command-like tool results.
 *
 * @param result - Unknown tool handler result.
 * @returns Tool messages contained by the result.
 */
function getToolMessages(result: unknown): ToolMessage[] {
  if (ToolMessage.isInstance(result)) {
    return [result];
  }
  if (typeof result !== "object" || result === null) {
    return [];
  }
  const candidate = result as { update?: { messages?: unknown[] } };
  return (candidate.update?.messages ?? []).filter(
    (message): message is ToolMessage => ToolMessage.isInstance(message),
  );
}
