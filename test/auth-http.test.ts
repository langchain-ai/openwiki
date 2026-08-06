import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchWithAuthTimeout } from "../src/auth/http.ts";

describe("fetchWithAuthTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("rejects a fetch that never settles and aborts its signal", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: unknown, init?: { signal?: AbortSignal }) => {
        requestSignal = init?.signal;
        return new Promise<Response>(() => {});
      }),
    );

    const pending = fetchWithAuthTimeout(
      "https://auth.example.test/token",
      {},
      { operation: "Token exchange", timeoutMs: 1000 },
    );
    const rejection = expect(pending).rejects.toThrow(
      "Token exchange timed out after 1000ms",
    );
    await vi.advanceTimersByTimeAsync(1000);

    await rejection;
    expect(requestSignal?.aborted).toBe(true);
  });

  test("propagates caller cancellation instead of converting it to a timeout", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: { signal?: AbortSignal }) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(
                init.signal?.reason instanceof Error
                  ? init.signal.reason
                  : new Error("cancelled"),
              ),
            );
          }),
      ),
    );

    const pending = fetchWithAuthTimeout(
      "https://auth.example.test/token",
      { signal: controller.signal },
      { timeoutMs: 60_000 },
    );
    const reason = new Error("cancelled by caller");
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });
});
