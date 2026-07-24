import { afterEach, describe, expect, test, vi } from "vitest";
import {
  fetchWithResilience,
  isRetryableStatus,
  parseRetryAfterMs,
} from "../src/connectors/http.ts";

// Connectors used to call fetch directly with no timeout and no retry, so a
// single 429 or transient 5xx aborted the whole run (issue #412 / connector
// resilience). These tests pin the retry/backoff/timeout contract of the shared
// helper. Sleep and RNG are injected so the suite never actually waits.

const noSleep = () => Promise.resolve();
const fixedRandom = () => 0.5;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetchSequence(
  responses: (() => Promise<Response> | Response)[],
): ReturnType<typeof vi.fn> {
  let call = 0;
  const stub = vi.fn(() => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return Promise.resolve(next());
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

describe("isRetryableStatus", () => {
  test("flags 429 and 5xx, not 2xx/3xx/4xx", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(304)).toBe(false);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });
});

describe("parseRetryAfterMs", () => {
  test("parses delta-seconds", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  test("parses an HTTP-date relative to now", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfterMs("Thu, 01 Jan 2026 00:00:05 GMT", now)).toBe(5000);
    // A past date clamps to zero rather than going negative.
    expect(parseRetryAfterMs("Wed, 31 Dec 2025 23:59:55 GMT", now)).toBe(0);
  });

  test("returns null for missing or unparseable values", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("soon")).toBeNull();
    // A date without a `now` reference cannot be turned into a delay.
    expect(parseRetryAfterMs("Thu, 01 Jan 2026 00:00:05 GMT")).toBeNull();
  });
});

describe("fetchWithResilience", () => {
  test("retries a 429 then returns the eventual success", async () => {
    const stub = stubFetchSequence([
      () => new Response("slow down", { status: 429 }),
      () => new Response("ok", { status: 200 }),
    ]);

    const response = await fetchWithResilience(
      "https://api.example.com/x",
      {},
      { sleep: noSleep, random: fixedRandom },
    );

    expect(response.status).toBe(200);
    expect(stub).toHaveBeenCalledTimes(2);
  });

  test("honors a numeric Retry-After header for the delay", async () => {
    stubFetchSequence([
      () =>
        new Response("slow down", {
          headers: { "retry-after": "2" },
          status: 429,
        }),
      () => new Response("ok", { status: 200 }),
    ]);

    const delays: number[] = [];
    const response = await fetchWithResilience(
      "https://api.example.com/x",
      {},
      {
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
        random: fixedRandom,
      },
    );

    expect(response.status).toBe(200);
    expect(delays).toEqual([2000]);
  });

  test("honors an HTTP-date Retry-After header relative to the current time", async () => {
    // The helper passes Date.now() into parseRetryAfterMs, so an HTTP-date
    // header must be turned into a real delay in production (not just in the
    // unit test that supplies `now` explicitly). Pin the clock to make the
    // expected delta deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    try {
      stubFetchSequence([
        () =>
          new Response("slow down", {
            headers: { "retry-after": "Thu, 01 Jan 2026 00:00:05 GMT" },
            status: 429,
          }),
        () => new Response("ok", { status: 200 }),
      ]);

      const delays: number[] = [];
      const response = await fetchWithResilience(
        "https://api.example.com/x",
        {},
        {
          sleep: (ms) => {
            delays.push(ms);
            return Promise.resolve();
          },
          random: fixedRandom,
        },
      );

      expect(response.status).toBe(200);
      expect(delays).toEqual([5000]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("retries transient 5xx up to the limit then returns the last response", async () => {
    const stub = stubFetchSequence([
      () => new Response("err", { status: 503 }),
    ]);

    const response = await fetchWithResilience(
      "https://api.example.com/x",
      {},
      { maxRetries: 2, sleep: noSleep, random: fixedRandom },
    );

    // Initial attempt + 2 retries = 3 calls, and the final 503 is returned.
    expect(response.status).toBe(503);
    expect(stub).toHaveBeenCalledTimes(3);
  });

  test("does NOT retry a 401 so callers can refresh tokens", async () => {
    const stub = stubFetchSequence([
      () => new Response("unauthorized", { status: 401 }),
    ]);

    const response = await fetchWithResilience(
      "https://api.example.com/x",
      {},
      { sleep: noSleep, random: fixedRandom },
    );

    expect(response.status).toBe(401);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  test("does NOT retry a 4xx client error", async () => {
    const stub = stubFetchSequence([
      () => new Response("bad", { status: 400 }),
    ]);

    const response = await fetchWithResilience(
      "https://api.example.com/x",
      {},
      { sleep: noSleep, random: fixedRandom },
    );

    expect(response.status).toBe(400);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  test("retries network errors then rethrows the last one when exhausted", async () => {
    const stub = vi.fn(() => Promise.reject(new Error("ECONNRESET")));
    vi.stubGlobal("fetch", stub);

    await expect(
      fetchWithResilience(
        "https://api.example.com/x",
        {},
        { maxRetries: 2, sleep: noSleep, random: fixedRandom },
      ),
    ).rejects.toThrow("ECONNRESET");
    expect(stub).toHaveBeenCalledTimes(3);
  });

  test("defaults to Math.random for real jitter on the backoff delay", async () => {
    // With no `random` injected the helper must draw from Math.random, so the
    // backoff delay is jittered rather than a fixed fraction of the ceiling.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.25);
    stubFetchSequence([
      () => new Response("err", { status: 503 }),
      () => new Response("ok", { status: 200 }),
    ]);

    const delays: number[] = [];
    const response = await fetchWithResilience(
      "https://api.example.com/x",
      {},
      {
        baseDelayMs: 1000,
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      },
    );

    expect(response.status).toBe(200);
    expect(randomSpy).toHaveBeenCalled();
    // ceiling = min(20000, 1000 * 2**0) = 1000; 0.25 * 1000 = 250.
    expect(delays).toEqual([250]);
  });

  test("passes an AbortSignal to fetch so a hung request can time out", async () => {
    const stub = vi.fn((_input: unknown, init?: { signal?: AbortSignal }) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(new Response("ok", { status: 200 }));
    });
    vi.stubGlobal("fetch", stub);

    const response = await fetchWithResilience(
      "https://api.example.com/x",
      {},
      { sleep: noSleep, random: fixedRandom },
    );

    expect(response.status).toBe(200);
  });
});
