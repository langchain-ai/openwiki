import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { OpenWikiRunOptions } from "../../src/agent/types.ts";
import {
  computeOpenRouterRetryDelayMs,
  installOpenRouterDebugFetch,
} from "../../src/agent/index.ts";

const RETRY_ENV_KEY = "OPENWIKI_PROVIDER_RETRY_ATTEMPTS";
const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ input: unknown; init?: RequestInit }>;
let fetchResponses: Array<() => Response>;
let savedEnv: string | undefined;

beforeEach(() => {
  fetchCalls = [];
  fetchResponses = [];
  savedEnv = process.env[RETRY_ENV_KEY];
  process.env[RETRY_ENV_KEY] = "3";
});

afterEach(() => {
  process.env[RETRY_ENV_KEY] = savedEnv;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function jsonResponse(status: number, headers: Record<string, string> = {}, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function installMockFetch(responders: Array<() => Response>): void {
  fetchResponses = responders;
  let index = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    fetchCalls.push({ input, init });
    const responder = fetchResponses[Math.min(index, fetchResponses.length - 1)];
    index += 1;
    return responder();
  }) as typeof fetch;
}

// Minimal options: emitDebug no-ops without `debug`.
const noDebugOptions: OpenWikiRunOptions = {};

describe("installOpenRouterDebugFetch 429 retry (#664)", () => {
  test("retries a Retry-After-less 429 and honours X-RateLimit-Reset", async () => {
    // The exact OpenRouter free-tier shape: 429, no Retry-After, reset as unix-ms.
    const resetAt = Date.now() + 40;
    installMockFetch([
      () => jsonResponse(429, { "x-ratelimit-reset": String(resetAt) }, { error: { code: 429 } }),
      () => jsonResponse(200, {}, { choices: [] }),
    ]);

    const capture = installOpenRouterDebugFetch(noDebugOptions);
    const startedAt = Date.now();
    const response = await globalThis.fetch(CHAT_URL, {
      method: "POST",
      body: JSON.stringify({ model: "x:free", stream: true }),
    });
    const waitedMs = Date.now() - startedAt;
    capture.restore();

    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(2);
    // The retry waited for the reset window (40ms minus scheduling slack).
    expect(waitedMs).toBeGreaterThanOrEqual(25);
  });

  test("returns the final 429 after exhausting the attempt budget", async () => {
    installMockFetch([() => jsonResponse(429, { "x-ratelimit-reset": String(Date.now()) })]);

    const capture = installOpenRouterDebugFetch(noDebugOptions);
    const response = await globalThis.fetch(CHAT_URL, {
      method: "POST",
      body: JSON.stringify({ model: "x:free" }),
    });
    const failure = capture.getLastFailure();
    capture.restore();

    expect(response.status).toBe(429);
    // 1 initial attempt + 3 retries from OPENWIKI_PROVIDER_RETRY_ATTEMPTS=3.
    expect(fetchCalls).toHaveLength(4);
    expect(failure?.response?.status).toBe(429);
  });

  test("does not retry non-OpenRouter requests", async () => {
    installMockFetch([() => jsonResponse(429)]);

    const capture = installOpenRouterDebugFetch(noDebugOptions);
    const response = await globalThis.fetch("https://example.com/api", {
      method: "POST",
      body: "{}",
    });
    capture.restore();

    expect(response.status).toBe(429);
    expect(fetchCalls).toHaveLength(1);
  });

  test("does not retry when the body cannot be re-sent", async () => {
    installMockFetch([() => jsonResponse(429)]);

    const capture = installOpenRouterDebugFetch(noDebugOptions);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    });
    const response = await globalThis.fetch(CHAT_URL, {
      method: "POST",
      body: stream,
    });
    capture.restore();

    expect(response.status).toBe(429);
    expect(fetchCalls).toHaveLength(1);
  });

  test("a network error on retry keeps the fetchError diagnostics", async () => {
    installMockFetch([
      () => jsonResponse(429, { "x-ratelimit-reset": String(Date.now()) }),
      () => {
        throw new Error("socket hang up");
      },
    ]);

    const capture = installOpenRouterDebugFetch(noDebugOptions);
    await expect(
      globalThis.fetch(CHAT_URL, { method: "POST", body: "{}" }),
    ).rejects.toThrow("socket hang up");
    const failure = capture.getLastFailure();
    capture.restore();

    expect(fetchCalls).toHaveLength(2);
    expect(failure?.fetchError).toBe("socket hang up");
  });
});

describe("computeOpenRouterRetryDelayMs", () => {
  const responseWith = (headers: Record<string, string>) =>
    new Response("{}", { status: 429, headers });

  test("uses Retry-After seconds when present", () => {
    expect(computeOpenRouterRetryDelayMs(responseWith({ "retry-after": "7" }), 1)).toBe(7_000);
  });

  test("uses an HTTP-date Retry-After relative to now", () => {
    const date = new Date(Date.now() + 5_000).toUTCString();
    const delay = computeOpenRouterRetryDelayMs(responseWith({ "retry-after": date }), 1);
    expect(delay).toBeGreaterThan(3_000);
    expect(delay).toBeLessThanOrEqual(5_000);
  });

  test("falls back to X-RateLimit-Reset (unix ms) with a small margin", () => {
    const resetAt = Date.now() + 2_000;
    const delay = computeOpenRouterRetryDelayMs(
      responseWith({ "x-ratelimit-reset": String(resetAt) }),
      1,
    );
    expect(delay).toBeGreaterThan(2_000);
    expect(delay).toBeLessThanOrEqual(2_500);
  });

  test("interprets a seconds-magnitude X-RateLimit-Reset as unix seconds", () => {
    const resetAtSeconds = Math.floor(Date.now() / 1_000) + 3;
    const delay = computeOpenRouterRetryDelayMs(
      responseWith({ "x-ratelimit-reset": String(resetAtSeconds) }),
      1,
    );
    expect(delay).toBeGreaterThan(2_500);
    expect(delay).toBeLessThanOrEqual(3_500);
  });

  test("grows exponentially when no hint is present", () => {
    const none = responseWith({});
    expect(computeOpenRouterRetryDelayMs(none, 1)).toBe(1_000);
    expect(computeOpenRouterRetryDelayMs(none, 2)).toBe(2_000);
    expect(computeOpenRouterRetryDelayMs(none, 3)).toBe(4_000);
    expect(computeOpenRouterRetryDelayMs(none, 10)).toBe(30_000);
  });
});
