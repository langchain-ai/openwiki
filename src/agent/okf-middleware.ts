import { ToolMessage } from "@langchain/core/messages";
import type { BackendProtocolV2 } from "deepagents";
import { createMiddleware } from "langchain";
import path from "node:path";
import { validateWikiMermaid } from "../mermaid/wiki.js";
import {
  validatePersistedFile,
  type FrontmatterIssue,
} from "../okf/frontmatter.js";
import { migrateWikiToOkf, synchronizeWikiIndexes } from "../okf/index-sync.js";
import { MUTATION_PATH_METADATA_KEY } from "./docs-only-backend.js";
import type { OpenWikiOutputMode } from "./types.js";

const OKF_RESERVED_FILES = new Set(["index.md", "log.md"]);
const WRITE_TOOLS = new Set(["write_file", "edit_file"]);

/**
 * Creates middleware that keeps the wiki OKF-conformant around a run. It
 * migrates existing pages to valid front matter before the agent starts
 * and synchronizes indexes after the run.
 */
export function createOpenWikiIndexMiddleware(
  backend: BackendProtocolV2,
  outputMode: OpenWikiOutputMode,
) {
  return createMiddleware({
    name: "OpenWikiIndexMiddleware",
    beforeAgent: async () => {
      await migrateWikiToOkf(backend, outputMode);
    },
    wrapToolCall: async (request, handler) => {
      // Let the tool execute first. If the tool itself throws, the error
      // propagates through LangChain's composition layer as a
      // MiddlewareError whose root cause is NOT a ToolInvocationError.
      // ToolNode.#handleError then re-throws it as fatal because
      // handleToolErrors !== true. To avoid that crash path, we catch
      // tool execution errors here and convert them to ToolMessages so
      // the LLM can see the failure and retry.
      let result: unknown;
      try {
        result = await handler(request);
      } catch (error) {
        // Re-throw GraphInterrupt and abort signals untouched — those are
        // control flow, not tool failures.
        if (isGraphInterruptLike(error) || isAborted(error)) {
          throw error;
        }
        // Convert the tool error into a ToolMessage. This mirrors
        // LangChain's defaultHandleToolErrors but runs before the
        // composition layer wraps it in MiddlewareError.
        return toolErrorToMessage(error, request.toolCall);
      }

      // Only post-process successful results — frontmatter validation
      // must not run on error results (which are already ToolMessages).
      return addFrontmatterWarning(
        result,
        backend,
        outputMode,
        request.toolCall.name,
      );
    },
    afterAgent: async () => {
      await validateWikiMermaid(backend, outputMode);
      await synchronizeWikiIndexes(backend, outputMode);
    },
  });
}

/**
 * Appends an actionable warning when a wiki write leaves invalid front matter.
 *
 * Errors from `validatePersistedFile` are caught and swallowed so a
 * validation failure never crashes the agent run — the original tool
 * result is returned unchanged.
 */
export async function addFrontmatterWarning<Result>(
  result: Result,
  backend: BackendProtocolV2,
  outputMode: OpenWikiOutputMode,
  toolName: string,
): Promise<Result> {
  if (!WRITE_TOOLS.has(toolName)) return result;

  const mutation = getToolMessages(result)
    .map((message) => ({
      message,
      path: message.metadata?.[MUTATION_PATH_METADATA_KEY],
    }))
    .find(
      (item): item is { message: ToolMessage; path: string } =>
        typeof item.path === "string" &&
        isWikiMarkdownPath(item.path, outputMode),
    );
  if (!mutation) return result;

  try {
    const validation = await validatePersistedFile(backend, mutation.path);
    if (validation.valid) return result;

    const warning = formatWarning(mutation.path, validation.issues);
    mutation.message.content =
      typeof mutation.message.content === "string"
        ? `${mutation.message.content}\n\n${warning}`
        : [...mutation.message.content, { text: warning, type: "text" }];
  } catch {
    // Swallow validation errors — a failed frontmatter check must not
    // prevent the tool result from reaching the LLM.
  }

  return result;
}

/**
 * Extracts tool messages from direct and Command-like tool results.
 */
function getToolMessages(result: unknown): ToolMessage[] {
  if (ToolMessage.isInstance(result)) return [result];
  if (!isRecord(result)) return [];

  const messages = isRecord(result.update) ? result.update.messages : undefined;
  return Array.isArray(messages)
    ? messages.filter((message): message is ToolMessage =>
        ToolMessage.isInstance(message),
      )
    : [];
}

/**
 * Checks whether a path targets an OKF concept document inside the wiki.
 */
function isWikiMarkdownPath(
  filePath: string,
  outputMode: OpenWikiOutputMode,
): boolean {
  const normalized = path.posix.normalize(
    `/${filePath.trim().replaceAll("\\", "/").replace(/^\/+/, "")}`,
  );
  return (
    path.posix.extname(normalized).toLowerCase() === ".md" &&
    !OKF_RESERVED_FILES.has(path.posix.basename(normalized).toLowerCase()) &&
    (outputMode === "local-wiki" || normalized.startsWith("/openwiki/"))
  );
}

/**
 * Formats validation issues as an instruction for the agent to correct the file.
 */
function formatWarning(path: string, issues: FrontmatterIssue[]): string {
  const details = issues
    .map(
      ({ code, line, message }) =>
        `- [${code}]${line ? ` line ${line}:` : ""} ${message}`,
    )
    .join("\n");
  return `WARNING: YAML front matter was NOT formatted properly in \`${path}\`.\n${details}\nYou MUST correct this file's YAML front matter before continuing.`;
}

/**
 * Narrows an unknown value to a non-array object record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Returns true when the error is a LangGraph interrupt (graph-level control
 * flow that must propagate untouched).
 */
function isGraphInterruptLike(error: unknown): boolean {
  if (!isRecord(error)) return false;
  // LangGraph Interrupt errors carry a `__interrupt` symbol or type marker.
  if (error.__interrupt === true) return true;
  if (typeof error.type === "string" && error.type === "interrupt") return true;
  return false;
}

/**
 * Returns true when the error signals an aborted run.
 */
function isAborted(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.name === "AbortError" || error.name === "CancelledError") return true;
  return false;
}

/**
 * Converts a thrown tool error into a ToolMessage so the LLM sees the
 * failure message and can retry, instead of the process crashing.
 */
function toolErrorToMessage(
  error: unknown,
  toolCall: { id: string; name: string },
): ToolMessage {
  const message =
    error instanceof Error ? error.message : String(error);
  return new ToolMessage({
    content: `${message}\n Please fix your mistakes.`,
    tool_call_id: toolCall.id,
    name: toolCall.name,
  });
}
