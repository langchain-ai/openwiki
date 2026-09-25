import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { SystemRunError } from "../core/errors.js";
import { OpenWikiSystem } from "./openwiki-system.js";
import type {
  OpenWikiRunOptions,
  OpenWikiRunResult,
} from "../../../src/agent/types.js";

/**
 * Control state for the faked OpenWiki entrypoint. `result` is returned by the
 * fake `runOpenWikiAgent`, `error` (when set) is thrown instead, and `calls`
 * records the arguments so a test can assert the adapter wired them correctly.
 */
const controller = vi.hoisted(() => ({
  result: { command: "init", model: "m" } as OpenWikiRunResult,
  error: undefined as Error | undefined,
  calls: [] as Array<{
    command: string;
    cwd: string;
    options: OpenWikiRunOptions;
  }>,
}));

// Replace the real entrypoint so no provider is constructed and no network call
// is made: the adapter's own translation of args, result, and errors is what is
// under test here. The live smoke test lives in a separate file so it keeps the
// real module.
vi.mock("../../../src/agent/index.js", () => ({
  runOpenWikiAgent: async (
    command: string,
    cwd: string,
    options: OpenWikiRunOptions,
  ): Promise<OpenWikiRunResult> => {
    controller.calls.push({ command, cwd, options });

    if (controller.error !== undefined) {
      throw controller.error;
    }

    return controller.result;
  },
}));

/**
 * Snapshot of the two env keys the adapter mutates, so each test can restore the
 * process environment and never leak a provider or model id into another test
 * file.
 */
let savedProvider: string | undefined;
let savedModelId: string | undefined;

beforeEach(() => {
  controller.result = { command: "init", model: "m" };
  controller.error = undefined;
  controller.calls = [];
  savedProvider = process.env.OPENWIKI_PROVIDER;
  savedModelId = process.env.OPENWIKI_MODEL_ID;
});

afterEach(() => {
  if (savedProvider === undefined) {
    delete process.env.OPENWIKI_PROVIDER;
  } else {
    process.env.OPENWIKI_PROVIDER = savedProvider;
  }

  if (savedModelId === undefined) {
    delete process.env.OPENWIKI_MODEL_ID;
  } else {
    process.env.OPENWIKI_MODEL_ID = savedModelId;
  }
});

describe("OpenWikiSystem.run", () => {
  test("init reports a repository run and honors the skip signal", async () => {
    controller.result = { command: "init", model: "m", skipped: true };
    const system = new OpenWikiSystem({
      provider: "anthropic",
      modelId: "claude-x",
    });

    const outcome = await system.init("/worktree");

    expect(outcome.skipped).toBe(true);
    expect(Number.isInteger(outcome.durationMs)).toBe(true);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);

    // The adapter must drive OpenWiki in repository mode so the worktree cwd is
    // honored, and pass the configured model through.
    expect(controller.calls).toHaveLength(1);
    expect(controller.calls[0].command).toBe("init");
    expect(controller.calls[0].cwd).toBe("/worktree");
    expect(controller.calls[0].options.outputMode).toBe("repository");
    expect(controller.calls[0].options.modelId).toBe("claude-x");

    // Provider is conveyed only through the environment, and the model id is
    // mirrored there too when set.
    expect(process.env.OPENWIKI_PROVIDER).toBe("anthropic");
    expect(process.env.OPENWIKI_MODEL_ID).toBe("claude-x");
  });

  test("update treats an absent skip flag as not skipped and passes modelId undefined when unset", async () => {
    controller.result = { command: "update", model: "m" };
    delete process.env.OPENWIKI_MODEL_ID;
    const system = new OpenWikiSystem({ provider: "openai" });

    const outcome = await system.update("/worktree");

    expect(outcome.skipped).toBe(false);
    expect(controller.calls[0].command).toBe("update");
    // With no configured model the adapter passes undefined so OpenWiki resolves
    // its own default, and it leaves OPENWIKI_MODEL_ID untouched.
    expect(controller.calls[0].options.modelId).toBeUndefined();
    expect(process.env.OPENWIKI_MODEL_ID).toBeUndefined();
  });

  test("wraps a thrown OpenWiki error in SystemRunError with context", async () => {
    controller.error = new Error("boom");
    const system = new OpenWikiSystem({ provider: "anthropic" });

    const rejection = system.init("/worktree");

    await expect(rejection).rejects.toBeInstanceOf(SystemRunError);
    await expect(rejection).rejects.toThrow(/init/);
    await expect(rejection).rejects.toThrow(/\/worktree/);
    await expect(rejection).rejects.toThrow(/boom/);
  });
});
