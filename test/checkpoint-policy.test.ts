import { describe, expect, test } from "vitest";
import { resolveCheckpointTarget } from "../src/agent/index.ts";

describe("checkpoint persistence policy", () => {
  test("keeps chat checkpoints in the persistent OpenWiki database", () => {
    const target = resolveCheckpointTarget("chat");

    expect(target.persistent).toBe(true);
    expect(target.connString).toMatch(/openwiki\.sqlite$/u);
  });

  test.each(["init", "update"] as const)(
    "uses an in-memory checkpoint database for %s runs",
    (command) => {
      const target = resolveCheckpointTarget(command);

      expect(target).toEqual({
        connString: ":memory:",
        persistent: false,
      });
    },
  );
});
