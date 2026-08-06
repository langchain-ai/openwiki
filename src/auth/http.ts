const DEFAULT_AUTH_FETCH_TIMEOUT_MS = 15_000;

export type AuthFetchOptions = {
  timeoutMs?: number;
  operation?: string;
};

/** Run one authentication request with a hard deadline; exchanges are not retried. */
export async function fetchWithAuthTimeout(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1] = {},
  options: AuthFetchOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_AUTH_FETCH_TIMEOUT_MS;
  const operation = options.operation ?? "Authentication request";
  const timeoutController = new AbortController();
  const callerSignal = init.signal;
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutController.signal])
    : timeoutController.signal;

  let rejectTimeout!: (error: Error) => void;
  const timeoutError = new Error(
    `${operation} timed out after ${timeoutMs}ms. Check your network connection and try again.`,
  );
  timeoutError.name = "AuthFetchTimeoutError";
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  let removeCallerAbortListener: (() => void) | undefined;
  const callerAbortPromise = callerSignal
    ? new Promise<never>((_, reject) => {
        const rejectCaller = () => {
          const reason: unknown = callerSignal.reason as unknown;
          reject(
            reason instanceof Error
              ? reason
              : new Error("Request cancelled by caller"),
          );
        };

        if (callerSignal.aborted) {
          rejectCaller();
          return;
        }

        callerSignal.addEventListener("abort", rejectCaller, { once: true });
        removeCallerAbortListener = () =>
          callerSignal.removeEventListener("abort", rejectCaller);
      })
    : null;

  const timeoutId = setTimeout(() => {
    timeoutController.abort(timeoutError);
    rejectTimeout(timeoutError);
  }, timeoutMs);

  try {
    const request = fetch(input, { ...init, signal });
    return await Promise.race(
      callerAbortPromise
        ? [request, timeoutPromise, callerAbortPromise]
        : [request, timeoutPromise],
    );
  } finally {
    clearTimeout(timeoutId);
    removeCallerAbortListener?.();
  }
}

export const AUTH_FETCH_TIMEOUT_MS = DEFAULT_AUTH_FETCH_TIMEOUT_MS;
