import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ensureDomGlobals } from "../src/mermaid/dom-shim.ts";
import { createModel } from "../src/agent/index.ts";

// End-to-end regression for issue #3, using the REAL Anthropic Vertex SDK (no
// mock) and the REAL Mermaid DOM shim. The optional Mermaid validation path
// installs jsdom's window/document globals process-wide; the Anthropic SDK's
// browser guard (window && window.document && navigator all defined) then throws
// "browser-like environment" at client construction, aborting the whole run.
//
// This test would FAIL (throw that error) if dangerouslyAllowBrowser were
// removed from the AnthropicVertex construction — unlike the mocked unit test,
// it exercises the actual SDK guard, so it guards against a base-SDK option
// rename or a regression in the fix.
const PROJECT_KEY = "GOOGLE_CLOUD_PROJECT";
const LOCATION_KEY = "GOOGLE_CLOUD_LOCATION";

describe("gemini-enterprise Claude surface (real SDK + jsdom shim, issue #3)", () => {
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {
      [PROJECT_KEY]: process.env[PROJECT_KEY],
      [LOCATION_KEY]: process.env[LOCATION_KEY],
    };
    process.env[PROJECT_KEY] = "test-project";
    process.env[LOCATION_KEY] = "global";
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("constructs the Vertex Claude client with jsdom DOM globals present", async () => {
    // Install the real DOM globals exactly as the Mermaid validation path does.
    await ensureDomGlobals();
    expect(typeof globalThis.window).toBe("object");
    expect(typeof globalThis.document).toBe("object");

    const model = createModel(
      "gemini-enterprise",
      "publishers/anthropic/models/claude-opus-4-8",
      0,
    );

    // Must NOT throw "It looks like you're running in a browser-like environment".
    const client = (model as { createClient: () => unknown }).createClient();
    expect(client).toBeDefined();
  });
});
