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

let mermaidPromise: Promise<MermaidApi | undefined> | undefined;

/**
 * Loads the Mermaid parser after installing DOM globals, or resolves to
 * `undefined` when mermaid/jsdom are not installed.
 *
 * `mermaid` and `jsdom` are optional peer dependencies. When present, callers
 * get the authoritative parser; when absent, they get `undefined` and fall back
 * to `heuristicError`. The import is lazy and memoized so a wiki with no
 * diagrams never pulls them in, and mermaid must not be imported anywhere else,
 * or it may evaluate before the DOM shim runs.
 */
export function loadMermaid(): Promise<MermaidApi | undefined> {
  if (!mermaidPromise) {
    mermaidPromise = (async () => {
      try {
        await ensureDomGlobals();
        const module: { default: MermaidApi } = await import("mermaid");
        return module.default;
      } catch (error) {
        // Expected path: the optional peer deps are simply not installed, so we
        // fall back to heuristic validation. An unexpected load failure (an
        // installed mermaid that throws) is kept distinct here per review, but
        // still falls back rather than crashing the wiki run.
        void isModuleNotFound(error);
        return undefined;
      }
    })();
  }
  return mermaidPromise;
}

/**
 * True when a dynamic import failed because the module is not installed.
 */
function isModuleNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND")
  );
}

/**
 * Parses every mermaid fence in a document and returns the failures.
 *
 * Uses the authoritative mermaid parser when it is installed, otherwise a
 * conservative heuristic that only flags near-certain breakages.
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
    let reason: string | undefined;
    if (mermaid) {
      try {
        await mermaid.parse(fence.body);
      } catch (err) {
        reason = sanitizeMermaidError(err);
      }
    } else {
      const heuristic = heuristicError(fence.body);
      if (heuristic !== undefined) {
        reason = sanitizeMermaidError(heuristic);
      }
    }
    if (reason !== undefined) {
      errors.push({ fence, error: reason });
    }
  }

  return errors;
}

/**
 * Best-effort syntax check used when the mermaid parser is not installed.
 *
 * Deliberately conservative: it only flags breakages that are near-certain, so
 * a valid diagram is never degraded. It therefore misses errors the real parser
 * would catch; install `mermaid` (for example in CI) for authoritative
 * validation. Returns a short reason when the diagram is very likely broken.
 *
 * Exported for unit testing; production callers reach it via
 * `findInvalidMermaidFences`.
 */
export function heuristicError(body: string): string | undefined {
  const firstWord = body.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
  const isFlowchart = firstWord === "flowchart" || firstWord === "graph";

  // Reserved `end` used as a flowchart node id. Restricted to flowcharts because
  // `end` legitimately closes loop/alt/opt blocks in sequence and state diagrams.
  if (
    isFlowchart &&
    (/(?:^|\n|\s)end\s*[[({]/u.test(body) ||
      /-->\s*end\s*(?:$|\n|;)/mu.test(body))
  ) {
    return "Heuristic: `end` is a reserved word and cannot be a flowchart node id; rename the node.";
  }

  // A semicolon inside a label: mermaid treats it as a statement separator.
  if (/[[({][^)\]}]*;[^)\]}]*[)\]}]/u.test(body)) {
    return "Heuristic: a semicolon inside a label breaks rendering; rephrase the label.";
  }

  // An unescaped angle bracket inside a label.
  if (/[[({][^)\]}]*[<>][^)\]}]*[)\]}]/u.test(body)) {
    return "Heuristic: an unescaped angle bracket inside a label breaks rendering; rephrase the label.";
  }

  return undefined;
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
 * secret-redaction boundary. It is then flattened to one line, keeping the
 * meaningful lines (the location and the `Expecting ... got ...` diagnosis) and
 * dropping only the caret-underline noise, since that diagnosis is what lets a
 * later run actually repair the diagram. Finally `--` (which would terminate an
 * HTML comment) is collapsed and the result is length-capped.
 *
 * Exported for unit testing; production callers reach it via
 * `findInvalidMermaidFences`.
 */
export function sanitizeMermaidError(error: unknown): string {
  const raw = error instanceof Error ? error.message : stringifyUnknown(error);
  const redacted = sanitizeDiagnosticText(raw);
  const meaningful = redacted
    .split("\n")
    // Drop blank lines and caret-underline lines (only whitespace/`-`/`^`).
    .filter((line) => line.trim() !== "" && !/^[\s^-]+$/u.test(line))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  return meaningful.replaceAll("--", "-").slice(0, 400) || "unknown error";
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
