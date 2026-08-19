import { ToolMessage } from "@langchain/core/messages";
import type { BackendProtocolV2 } from "deepagents";
import { createMiddleware } from "langchain";
import path from "node:path";
import { validateWikiMermaid } from "../mermaid/wiki.js";
import {
  conceptBodiesEqual,
  removeFrontmatterField,
  setGeneratedEvent,
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
import { sanitizeDiagnosticText } from "../platform/diagnostics.js";
import { inStage } from "../telemetry/index.js";
import type { OpenWikiOutputMode } from "./types.js";
import { OPENWIKI_PRODUCER_ACTOR } from "../version.js";
import { validateWikiInternalLinks } from "./wiki-link-validator.js";

const OKF_RESERVED_FILES = new Set(["index.md", "log.md"]);
const WRITE_TOOLS = new Set(["write_file", "edit_file"]);

/**
 * Creates middleware that keeps the wiki OKF-conformant around a run. It
 * migrates existing pages to valid front matter before the agent starts,
 * stamps the code-owned `generated` provenance event on concept writes whose
 * body meaningfully changed, and synchronizes indexes after the run.
 *
 * `now` is the run's single stamp time (an ISO 8601 datetime), computed once by
 * the caller and threaded in so every page written in one run shares one
 * `generated.at` and the stamping stays deterministic under test. It defaults to
 * the current time so callers that do not stamp (or tests exercising only the
 * index passes) need not supply one.
 */
export function createOpenWikiIndexMiddleware(
  backend: BackendProtocolV2,
  outputMode: OpenWikiOutputMode,
  labels: IndexLabels = ENGLISH_INDEX_LABELS,
  conceptType: string = ENGLISH_CONCEPT_TYPE,
  now: string = new Date().toISOString(),
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
    wrapToolCall: async (request, handler) => {
      // Read the target's body just before the write so we can tell a
      // meaningful content change from a metadata-only or whitespace edit.
      const before = await readConceptContent(request, backend, outputMode);
      const result = await handler(request);
      await stampGeneratedProvenance(
        result,
        backend,
        outputMode,
        request.toolCall.name,
        before,
        now,
      );
      return addFrontmatterWarning(
        result,
        backend,
        outputMode,
        request.toolCall.name,
      );
    },
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
 * Stamps the code-owned OKF `generated` provenance event on a concept write
 * whose body meaningfully changed (SPEC §5.1). OpenWiki owns this field end to
 * end: the model never authors it, so freshness never rests on a hallucinated
 * date. A newly created concept (no `before` content) is always stamped; a write
 * that only reshuffles front matter or whitespace leaves `generated` alone.
 *
 * The stamp writes `generated: {by: openwiki/<version>, at: <run time>}` and
 * drops any superseded legacy `timestamp` on the same page. Reserved documents
 * (`index.md`/`log.md`) and non-wiki paths are skipped by {@link isWikiMarkdownPath}.
 *
 * Stamping is best-effort. The tool's own write has already persisted the page
 * body by the time this runs, so a stamp failure must never take the run down
 * with it: any error is logged and swallowed, leaving the page validly unstamped
 * (`generated` is optional in OKF v0.2) for a later body-changing update to
 * stamp. This guard is load-bearing, not cosmetic: the tool node re-raises a
 * throw from `wrapToolCall` as a fatal `MiddlewareError` rather than feeding it
 * back to the model, so without it a failed provenance write would fail an
 * otherwise-successful run.
 */
async function stampGeneratedProvenance(
  result: unknown,
  backend: BackendProtocolV2,
  outputMode: OpenWikiOutputMode,
  toolName: string,
  before: string | undefined,
  now: string,
): Promise<void> {
  if (!WRITE_TOOLS.has(toolName)) return;

  const mutationPath = getMutationPath(result);
  if (
    mutationPath === undefined ||
    !isWikiMarkdownPath(mutationPath, outputMode)
  ) {
    return;
  }

  try {
    const after = await readContent(backend, mutationPath);
    if (after === undefined) return;

    // An unchanged body must not bump the recorded change time. A brand-new page
    // (no `before`) has no prior body to match, so it always stamps.
    if (before !== undefined && conceptBodiesEqual(before, after)) return;

    const stamped = removeFrontmatterField(
      setGeneratedEvent(after, OPENWIKI_PRODUCER_ACTOR, now),
      "timestamp",
    );
    // Re-stamping within one run (same `now`, no `timestamp`) is a no-op; skip the
    // redundant write so idempotent rewrites do not churn the file.
    if (stamped !== after) {
      await backend.write(mutationPath, stamped);
    }
  } catch (error) {
    console.error(
      `OpenWiki: could not stamp generated provenance on "${mutationPath}": ${sanitizeDiagnosticText(
        error instanceof Error ? error.message : String(error),
      )}`,
    );
  }
}

/**
 * Reads the target concept's current content just before a write, or undefined
 * when the request targets no readable wiki concept path (so the caller treats
 * the write as a new file). Path resolution mirrors the deepagents write tools,
 * which key the target as `file_path` (tolerating `path`).
 */
async function readConceptContent(
  request: { toolCall: { args?: unknown } },
  backend: BackendProtocolV2,
  outputMode: OpenWikiOutputMode,
): Promise<string | undefined> {
  const args = request.toolCall.args;
  if (!isRecord(args)) return undefined;
  const filePath = args.file_path ?? args.path;
  if (
    typeof filePath !== "string" ||
    !isWikiMarkdownPath(filePath, outputMode)
  ) {
    return undefined;
  }
  return readContent(backend, filePath);
}

/**
 * Reads a file's text through the backend, returning undefined when it is
 * missing, unreadable, or binary.
 */
async function readContent(
  backend: BackendProtocolV2,
  filePath: string,
): Promise<string | undefined> {
  let read: Awaited<ReturnType<BackendProtocolV2["readRaw"]>>;
  try {
    // A not-yet-created file throws rather than returning an error result; that
    // is the new-file case, where there is no prior body to compare against.
    read = await backend.readRaw(filePath);
  } catch {
    return undefined;
  }
  const content = read.data?.content;
  if (read.error || content === undefined || content instanceof Uint8Array) {
    return undefined;
  }
  return Array.isArray(content) ? content.join("\n") : content;
}

/**
 * Resolves the persisted path a write tool mutated, from the mutation metadata
 * the docs-only backend stamps on its tool messages.
 */
function getMutationPath(result: unknown): string | undefined {
  for (const message of getToolMessages(result)) {
    const path = message.metadata?.[MUTATION_PATH_METADATA_KEY];
    if (typeof path === "string") return path;
  }
  return undefined;
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
