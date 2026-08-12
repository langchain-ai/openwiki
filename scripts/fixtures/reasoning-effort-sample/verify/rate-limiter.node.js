import assert from "node:assert/strict";
import test from "node:test";
import { admitRequests } from "../src/rate-limiter.js";

test("preserves partial refill time between requests", () => {
  const result = admitRequests([0, 900, 1900, 2000], {
    capacity: 2,
    refillEveryMs: 1000,
  });

  assert.deepEqual(
    result.map(({ accepted }) => accepted),
    [true, true, true, true],
  );
});
