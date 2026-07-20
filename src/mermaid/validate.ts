import { sanitizeDiagnosticText } from "../diagnostics.js";
import { ensureDomGlobals } from "./dom-shim.js";
import { extractMermaidFences, type MermaidFence } from "./fences.js";

/**
 * A mermaid fence that failed to parse, paired with its sanitized error.
 */
export interface MermaidFenceError {
  /**
   * The fence whose body Mermaid rejected.
   */
  fence: MermaidFence;

  /**
   * The parser error, secret-redacted and made HTML-comment-safe.
   */
  error: string;
}

/**
 * The result of degrading the invalid fences in a single document.
 */
export interface MermaidDegradeResult {
  /**
   * The rewritten document, identical to the input when nothing degraded.
   */
  content: string;

  /**
   * How many fences were degraded to text fences.
   */
  degraded: number;
}

/**
 * The subset of the Mermaid API this module depends on.
 */
interface MermaidApi {
  /**
   * Parses diagram text and rejects when it is not renderable.
   */
  parse: (text: string) => Promise<unknown>;
}

let mermaidPromise: Promise<MermaidApi> | undefined;

/**
 * Loads the Mermaid parser after installing DOM globals.
 *
 * The import is lazy and memoized so a wiki with no diagrams never pulls in
 * mermaid or jsdom. Mermaid must not be imported anywhere else in the codebase,
 * or it may evaluate before the DOM shim runs.
 */
export function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    ensureDomGlobals();
    mermaidPromise = import("mermaid").then(
      (module) => module.default as unknown as MermaidApi,
    );
  }
  return mermaidPromise;
}

/**
 * Parses every mermaid fence in a document and returns the failures.
 */
export async function findInvalidMermaidFences(
  markdown: string,
): Promise<MermaidFenceError[]> {
  const fences = extractMermaidFences(markdown);
  if (fences.length === 0) {
    return [];
  }

  const mermaid = await loadMermaid();
  const errors: MermaidFenceError[] = [];

  for (const fence of fences) {
    try {
      await mermaid.parse(fence.body);
    } catch (err) {
      errors.push({ fence, error: sanitizeMermaidError(err) });
    }
  }

  return errors;
}

/**
 * Degrades invalid mermaid fences to plain ```text fences so content survives
 * and no broken diagram block reaches a renderer.
 *
 * Each degraded fence is preceded by an HTML comment carrying the parser error,
 * so a later update run can find it inline and repair the diagram. Returns the
 * input unchanged when every fence parses.
 */
export async function degradeInvalidMermaidFences(
  markdown: string,
): Promise<MermaidDegradeResult> {
  const errors = await findInvalidMermaidFences(markdown);
  if (errors.length === 0) {
    return { content: markdown, degraded: 0 };
  }

  const lines = markdown.split("\n");

  // Rewrite bottom-up so that earlier line indices stay valid as lines are spliced.
  for (const { fence, error } of [...errors].reverse()) {
    const comment =
      `${fence.indent}<!-- openwiki: mermaid parse failed and this diagram ` +
      `was converted to a text fence so it does not break rendering. Fix the ` +
      `diagram source and restore the mermaid fence. Parser error: ${error} -->`;
    lines.splice(
      fence.openLine,
      fence.closeLine - fence.openLine + 1,
      comment,
      `${fence.indent}${fence.marker}text`,
      ...fence.body.split("\n"),
      `${fence.indent}${fence.marker}`,
    );
  }

  return { content: lines.join("\n"), degraded: errors.length };
}

/**
 * Makes a thrown Mermaid parser error safe to embed in a wiki HTML comment.
 *
 * The error first passes through `sanitizeDiagnosticText`, the codebase's
 * secret-redaction boundary, then is reduced to its first two lines, has `--`
 * (which would terminate an HTML comment) collapsed, and is length-capped.
 *
 * Exported for unit testing; production callers reach it via
 * `findInvalidMermaidFences`.
 */
export function sanitizeMermaidError(error: unknown): string {
  const raw = error instanceof Error ? error.message : stringifyUnknown(error);
  const redacted = sanitizeDiagnosticText(raw);
  const firstLines = redacted.split("\n").slice(0, 2).join(" ").trim();
  return firstLines.replaceAll("--", "-").slice(0, 300) || "unknown error";
}

/**
 * Best-effort string form of a non-Error thrown value, never itself throwing.
 */
function stringifyUnknown(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}
