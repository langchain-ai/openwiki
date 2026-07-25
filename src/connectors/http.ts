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
 *     honoring a numeric or HTTP-date `Retry-After` header when present,
 *   - the same backoff on network errors (connection reset, DNS, timeout).
 *
 * Auth failures (401/403) and other 4xx are returned as-is: they are not
 * transient, and callers such as Gmail need to see a 401 to trigger a token
 * refresh. Retrying them would waste attempts and could lock accounts.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const MAX_BACKOFF_DELAY_MS = 20_000;

export interface FetchWithResilienceOptions {
  /** Per-attempt timeout in milliseconds. Default 30s. */
  timeoutMs?: number;
  /** Number of retries after the first attempt. Default 3. */
  maxRetries?: number;
  /** Base delay for exponential backoff in milliseconds. Default 500ms. */
  baseDelayMs?: number;
  /**
   * Injectable sleep, defaulting to a real timer. Overridden in tests so
   * backoff does not slow the suite. Receives the delay in milliseconds.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Injectable RNG in [0, 1) for jitter. Defaults to `Math.random` for real
   * full jitter so concurrent clients de-correlate their retries. Override in
   * tests to pin exact delays.
   */
  random?: () => number;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
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
        const delay =
          retryAfterMs ?? backoffDelayMs(attempt, baseDelayMs, random);
        // Discard the body so the connection can be reused before we retry.
        await response.body?.cancel();
        await sleep(delay);
        continue;
      }

      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries) {
        break;
      }
      await sleep(backoffDelayMs(attempt, baseDelayMs, random));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
