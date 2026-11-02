/**
 * Shared resilient HTTP helper for connector ingestion.
 *
 * Every connector (Gmail, Slack, X, Hacker News) and the HTTP MCP client used to
 * call `fetch` directly with no timeout and no retry: any 429 or transient 5xx
 * aborted the whole run, and a non-responsive server hung ingestion forever.
 *
 * `fetchWithResilience` adds:
 *   - a per-request wall-clock timeout via `AbortSignal.timeout`,
 *   - bounded exponential backoff with jitter on 429 and 5xx responses,
 *     honoring a numeric or HTTP-date `Retry-After` header within the cap,
 *   - the same backoff on network errors (connection reset, DNS, timeout).
 *
 * A caller AbortSignal is merged with the per-attempt timeout. Caller
 * cancellation is not retried: if that signal is aborted, the helper stops
 * immediately and does not sleep. A timeout-only abort leaves the caller
 * signal unset and is still treated as transient.
 *
 * Auth failures (401/403) and other 4xx are returned as-is: they are not
 * transient, and callers such as Gmail need to see a 401 to trigger a token
 * refresh. Retrying them would waste attempts and could lock accounts.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const MAX_BACKOFF_DELAY_MS = 20_000;

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export interface FetchWithResilienceOptions {
  /** Per-attempt timeout in milliseconds. Default 30s. */
  timeoutMs?: number;
  /** Number of retries after the first attempt. Default 3. */
  maxRetries?: number;
  /** Base delay for exponential backoff in milliseconds. Default 500ms. */
  baseDelayMs?: number;
  /**
   * Injectable sleep, defaulting to a real timer. Overridden in tests so
   * backoff does not slow the suite. Receives the delay and optional caller
   * signal so implementations can release their timer when cancellation wins.
   */
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  /**
   * Injectable RNG in [0, 1) for jitter. Defaults to `Math.random` for real
   * full jitter so concurrent clients de-correlate their retries. Override in
   * tests to pin exact delays.
   */
  random?: () => number;
}

const realSleep = (ms: number, signal?: AbortSignal | null): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(toError(signal.reason));
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(toError(signal?.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Whether an HTTP status is worth retrying (rate limit or server error). */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Parses a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds,
 * or `null` when absent/unparseable. `now` is injectable for testing the
 * HTTP-date branch without a clock dependency.
 */
export function parseRetryAfterMs(
  headerValue: string | null,
  now?: number,
): number | null {
  if (!headerValue) {
    return null;
  }

  const trimmed = headerValue.trim();
  if (/^\d+$/u.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs) || now === undefined) {
    return null;
  }

  return Math.max(0, dateMs - now);
}

function backoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  random: () => number,
): number {
  // Exponential backoff with full jitter, capped.
  const ceiling = Math.min(MAX_BACKOFF_DELAY_MS, baseDelayMs * 2 ** attempt);
  return Math.round(random() * ceiling);
}

async function waitForRetry(
  delayMs: number,
  sleep: NonNullable<FetchWithResilienceOptions["sleep"]>,
  signal?: AbortSignal | null,
): Promise<void> {
  if (!signal) {
    await sleep(delayMs);
    return;
  }
  if (signal.aborted) {
    throw toError(signal.reason);
  }

  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(toError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    await Promise.race([sleep(delayMs, signal), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * `fetch` with a per-attempt timeout and bounded retry/backoff on transient
 * failures. Non-transient responses (2xx/3xx/4xx) are returned to the caller
 * unchanged after the first attempt.
 */
export async function fetchWithResilience(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1] = {},
  options: FetchWithResilienceOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    // A caller-provided signal is honored alongside our timeout: whichever
    // aborts first wins.
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;

    try {
      const response = await fetch(input, { ...init, signal });

      if (attempt < maxRetries && isRetryableStatus(response.status)) {
        const retryAfterMs = parseRetryAfterMs(
          response.headers.get("retry-after"),
          Date.now(),
        );
        const delay = Math.min(
          MAX_BACKOFF_DELAY_MS,
          retryAfterMs ?? backoffDelayMs(attempt, baseDelayMs, random),
        );
        // Discard the body so the connection can be reused before we retry.
        await response.body?.cancel();
        await waitForRetry(delay, sleep, init.signal);
        continue;
      }

      return response;
    } catch (error) {
      lastError = error;
      // Timeout aborts are transient and share AbortError with caller
      // cancellation. Only the caller signal says the caller gave up.
      if (init.signal?.aborted === true || attempt >= maxRetries) {
        break;
      }
      await waitForRetry(
        backoffDelayMs(attempt, baseDelayMs, random),
        sleep,
        init.signal,
      );
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
