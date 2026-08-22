import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installOpenRouterDebugFetch } from "../src/agent/index.ts";
import { OPENROUTER_BASE_URL } from "../src/constants.ts";

// ChatOpenRouter calls globalThis.fetch directly (no injectable fetch), so the
// debug wrapper must patch the global. These tests pin the concurrency contract
// from issue #411: overlapping runs must each keep their own captured failure,
// and the real fetch must be restored exactly once — only after the last run
// detaches — so a patch can never leak or be lost.

const OPENROUTER_CHAT_URL = `${OPENROUTER_BASE_URL}/chat/completions`;
const OTHER_URL = "https://api.example.com/v1/chat/completions";

let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
});

afterEach(() => {
  // Guard against a test leaving the global patched.
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** A stub fetch that fails OpenRouter chat calls and passes everything else. */
function stubFetch(): typeof globalThis.fetch {
  const stub = vi.fn(
    (input: Parameters<typeof fetch>[0]): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(OPENROUTER_CHAT_URL)) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "rate limited" }), {
            status: 429,
            statusText: "Too Many Requests",
          }),
        );
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    },
  ) as unknown as typeof globalThis.fetch;
  globalThis.fetch = stub;
  return stub;
}

describe("installOpenRouterDebugFetch concurrency", () => {
  test("restores the exact original fetch after a single run", () => {
    const original = stubFetch();

    const capture = installOpenRouterDebugFetch({});
    expect(globalThis.fetch).not.toBe(original);

    capture.restore();
    expect(globalThis.fetch).toBe(original);
  });

  test("overlapping runs each capture their own failure and restore is reference-counted", async () => {
    const original = stubFetch();

    const events: string[] = [];
    const runA = installOpenRouterDebugFetch({});
    const runB = installOpenRouterDebugFetch({
      debug: true,
      onEvent: (e) => {
        if (e.type === "debug") {
          events.push(e.message);
        }
      },
    });

    // Only one wrapper is installed for both runs.
    const patched = globalThis.fetch;
    expect(patched).not.toBe(original);

    // An OpenRouter failure fans out to every active run's sink.
    await globalThis.fetch(OPENROUTER_CHAT_URL, {
      body: JSON.stringify({ model: "x", messages: [] }),
      method: "POST",
    });

    expect(runA.getLastFailure()?.response?.status).toBe(429);
    expect(runB.getLastFailure()?.response?.status).toBe(429);
    // Debug routing honors each run's options: only runB opted in.
    expect(events.some((m) => m.includes("openrouter.http status=429"))).toBe(
      true,
    );

    // runB can clear its own failure without touching runA's.
    runB.clearLastFailure();
    expect(runB.getLastFailure()).toBeNull();
    expect(runA.getLastFailure()?.response?.status).toBe(429);

    // First detach must NOT restore the global — runA is still active.
    runB.restore();
    expect(globalThis.fetch).toBe(patched);

    // Last detach restores the genuine original, not the wrapper.
    runA.restore();
    expect(globalThis.fetch).toBe(original);
  });

  test("passes non-OpenRouter requests through untouched", async () => {
    const original = stubFetch();
    const capture = installOpenRouterDebugFetch({});

    const response = await globalThis.fetch(OTHER_URL, { method: "POST" });

    expect(response.status).toBe(200);
    expect(capture.getLastFailure()).toBeNull();

    capture.restore();
    expect(globalThis.fetch).toBe(original);
  });

  test("redundant restore is a no-op and does not disturb an active run", () => {
    const original = stubFetch();
    const runA = installOpenRouterDebugFetch({});
    const runB = installOpenRouterDebugFetch({});
    const patched = globalThis.fetch;

    runA.restore();
    // Double restore of the same handle must not decrement twice and prematurely
    // restore while runB is still active.
    runA.restore();
    expect(globalThis.fetch).toBe(patched);

    runB.restore();
    expect(globalThis.fetch).toBe(original);
  });
});
