import { describe, expect, test } from "vitest";
import { ensureDomGlobals } from "../../src/mermaid/dom-shim.ts";

describe("ensureDomGlobals", () => {
  test("installs a window/document and is idempotent on a second call", async () => {
    await ensureDomGlobals();
    const installed = globalThis.window;
    expect(installed).toBeDefined();
    expect(globalThis.document).toBeDefined();

    // The second call must early-return once `window` exists rather than build a
    // fresh jsdom, so the globals stay identical.
    await ensureDomGlobals();
    expect(globalThis.window).toBe(installed);
  });
});
