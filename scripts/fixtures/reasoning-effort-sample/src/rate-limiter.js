export function admitRequests(times, { capacity, refillEveryMs }) {
  let tokens = capacity;
  let lastRefillMs = 0;

  return times.map((now) => {
    const elapsed = now - lastRefillMs;
    const refillCount = Math.floor(elapsed / refillEveryMs);
    if (refillCount > 0) {
      tokens = Math.min(capacity, tokens + refillCount);
      lastRefillMs += refillCount * refillEveryMs;
    }

    const accepted = tokens > 0;
    if (accepted) tokens -= 1;
    return { atMs: now, accepted, tokens };
  });
}
