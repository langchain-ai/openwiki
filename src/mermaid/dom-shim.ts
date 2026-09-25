/**
 * Installs the minimal DOM globals that Mermaid needs to parse headless.
 *
 * Mermaid's flowchart and state-diagram parsers call DOMPurify, which requires
 * a DOM. In bare Node, `mermaid.parse()` fails for those diagram types with
 * "DOMPurify.addHook is not a function". This shim installs a jsdom `window`
 * and `document` so parsing works without a browser.
 *
 * jsdom is imported dynamically because it is an optional peer dependency
 * (alongside `mermaid`). When it is not installed the import rejects, and
 * `loadMermaid()` in `validate.ts` treats that as "authoritative validation
 * unavailable" and falls back to heuristics.
 *
 * Order matters: the globals must exist before the `mermaid` module is first
 * imported, so callers must load mermaid through `loadMermaid()` (which calls
 * this first) rather than importing `mermaid` directly anywhere in the codebase.
 *
 * `globalThis.navigator` is a read-only getter in Node >= 21 and must not be
 * reassigned; mermaid parsing does not need it. This function is idempotent: a
 * second call is a no-op once `window` is present.
 */
export async function ensureDomGlobals(): Promise<void> {
  if (typeof globalThis.window !== "undefined") {
    return;
  }

  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!DOCTYPE html><body></body>");

  (globalThis as Record<string, unknown>).window = dom.window;
  (globalThis as Record<string, unknown>).document = dom.window.document;
}
