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
import {
  ENGLISH_CONCEPT_TYPE,
  ENGLISH_INDEX_LABELS,
  type IndexLabels,
} from "../okf/index-labels.js";
import { MUTATION_PATH_METADATA_KEY } from "./docs-only-backend.js";
import { inStage } from "../telemetry/index.js";
import type { OpenWikiOutputMode } from "./types.js";
import { validateWikiInternalLinks } from "./wiki-link-validator.js";

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
  labels: IndexLabels = ENGLISH_INDEX_LABELS,
  conceptType: string = ENGLISH_CONCEPT_TYPE,
) {
  return createMiddleware({
    name: "OpenWikiIndexMiddleware",
    beforeAgent: async () => {
      // Owned OKF pass: a throw here is our conformance code failing, not the
      // model. Tag class+detail at the origin so it does not fall to the run
      // stage's raw classifier (which would read agent_error).
      await inStage(
        "build",
        () => migrateWikiToOkf(backend, outputMode, conceptType),
        { errorClass: "okf_error", errorDetail: "migrate" },
      );
    },
    // Telemetry guard: this wrap only *decorates a successful* tool result with a
    // front-matter warning; it deliberately does not catch tool throws. LangChain's
    // tool node swallows a thrown tool error into a ToolMessage fed back to the
    // model so the agent can recover, so tool/connector throws never reach the run
    // failure path. Consequences to keep in mind before changing this:
    //   - `connector_error` has no fatal propagating path at all (the connector
    //     pull in runCodeModeConnectors is fail-open by design), so it is a
    //     documented telemetry blind spot, not a bucket some run produces.
    //   - `tool_error` is reachable only when a tool-named error escapes to the
    //     failure path; classifyError matches it by `error.name`, not here.
    //   - Tool-input parse errors are swallowed by LangChain upstream and never
    //     become `tool_error`.
    // Do not turn this into a catch that rethrows: that would make every recoverable
    // tool error fatal and record otherwise-successful runs as failures.
    wrapToolCall: async (request, handler) =>
      addFrontmatterWarning(
        await handler(request),
        backend,
        outputMode,
        request.toolCall.name,
      ),
    afterAgent: async () => {
      await inStage(
        "finalize",
        () => validateWikiMermaid(backend, outputMode),
        { errorClass: "okf_error", errorDetail: "mermaid" },
      );
      await inStage(
        "finalize",
        () => synchronizeWikiIndexes(backend, outputMode, labels, conceptType),
        { errorClass: "okf_error", errorDetail: "index_sync" },
      );
      // Stamp broken internal links in place (do not fail the run) so a later
      // update can repair them from the inline openwiki comments.
      await inStage(
        "finalize",
        () => validateWikiInternalLinks(backend, outputMode),
        { errorClass: "okf_error", errorDetail: "link_validation" },
      );
    },
  });
}

/**
 * Appends an actionable warning when a wiki write leaves invalid front matter.
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

  const validation = await validatePersistedFile(backend, mutation.path);
  if (validation.valid) return result;

  const warning = formatWarning(mutation.path, validation.issues);
  mutation.message.content =
    typeof mutation.message.content === "string"
      ? `${mutation.message.content}\n\n${warning}`
      : [...mutation.message.content, { text: warning, type: "text" }];
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
