import { describe, expect, test, vi } from "vitest";
import { requestProcessInterrupt } from "../../src/cli/process-interrupt.ts";

function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("requestProcessInterrupt", () => {
  test("restores the terminal before emitting SIGINT", async () => {
    const order: string[] = [];
    const target = {
      emit: vi.fn(() => {
        order.push("signal");
        return true;
      }),
      exit: vi.fn(),
    };

    requestProcessInterrupt(() => order.push("restore"), target);
    expect(order).toEqual(["restore"]);

    await flushImmediate();

    expect(order).toEqual(["restore", "signal"]);
    expect(target.exit).not.toHaveBeenCalled();
  });

  test("exits with the SIGINT code when no recovery handler exists", async () => {
    const target = {
      emit: vi.fn(() => false),
      exit: vi.fn(),
    };

    requestProcessInterrupt(() => undefined, target);
    await flushImmediate();

    expect(target.exit).toHaveBeenCalledWith(130);
  });
});
