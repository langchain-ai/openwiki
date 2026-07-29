import { afterEach, describe, expect, test, vi } from "vitest";

import { installOpenRouterDebugFetch } from "../src/agent/index.ts";

// The diagnostics patch used to capture globalThis.fetch per call and restore it
// blindly, so two overlapping runs corrupted each other's install/restore and
// could leak the wrapper into the global permanently (issue #411). These tests
// pin the reentrancy contract: one wrapper for any number of live installs, and
// the real fetch back only when the last one leaves.

const options = { debug: false } as Parameters<
  typeof installOpenRouterDebugFetch
>[0];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("installOpenRouterDebugFetch reentrancy", () => {
  test("a single install patches and restores exactly", () => {
    const real = vi.fn();
    vi.stubGlobal("fetch", real);

    const capture = installOpenRouterDebugFetch(options);
    expect(globalThis.fetch).not.toBe(real);

    capture.restore();
    expect(globalThis.fetch).toBe(real);
  });

  test("overlapping runs do not leak the wrapper (the issue's interleaving)", () => {
    const real = vi.fn();
    vi.stubGlobal("fetch", real);

    // 1. A installs, 2. B installs while A's patch is live
    const a = installOpenRouterDebugFetch(options);
    const patched = globalThis.fetch;
    const b = installOpenRouterDebugFetch(options);

    expect(globalThis.fetch).toBe(patched);

    // 3. A restores first, 4. B restores last
    a.restore();
    expect(globalThis.fetch).toBe(patched);

    b.restore();
    expect(globalThis.fetch).toBe(real);
  });

  test("out-of-order restore still lands on the real fetch", () => {
    const real = vi.fn();
    vi.stubGlobal("fetch", real);

    const a = installOpenRouterDebugFetch(options);
    const b = installOpenRouterDebugFetch(options);
    const c = installOpenRouterDebugFetch(options);

    b.restore();
    c.restore();
    expect(globalThis.fetch).not.toBe(real);

    a.restore();
    expect(globalThis.fetch).toBe(real);
  });

  test("a double restore cannot un-patch a run that is still live", () => {
    const real = vi.fn();
    vi.stubGlobal("fetch", real);

    const a = installOpenRouterDebugFetch(options);
    const b = installOpenRouterDebugFetch(options);

    a.restore();
    a.restore(); // idempotent — must not decrement past b
    expect(globalThis.fetch).not.toBe(real);

    b.restore();
    expect(globalThis.fetch).toBe(real);
  });

  test("each run gets its own failure slot", () => {
    vi.stubGlobal("fetch", vi.fn());
    const a = installOpenRouterDebugFetch(options);
    const b = installOpenRouterDebugFetch(options);

    expect(a.getLastFailure()).toBeNull();
    expect(b.getLastFailure()).toBeNull();

    a.clearLastFailure();
    expect(b.getLastFailure()).toBeNull();

    a.restore();
    b.restore();
  });

  test("a foreign patch installed over ours is not clobbered on restore", () => {
    const real = vi.fn();
    vi.stubGlobal("fetch", real);

    const capture = installOpenRouterDebugFetch(options);
    const foreign = vi.fn();
    globalThis.fetch = foreign;

    capture.restore();
    expect(globalThis.fetch).toBe(foreign);
  });

  test("non-OpenRouter requests pass straight through to the real fetch", async () => {
    const real = vi.fn(() => Promise.resolve(new Response("ok")));
    vi.stubGlobal("fetch", real);

    const capture = installOpenRouterDebugFetch(options);
    await globalThis.fetch("https://example.com/not-openrouter");

    expect(real).toHaveBeenCalledTimes(1);
    expect(capture.getLastFailure()).toBeNull();
    capture.restore();
  });
});
