import { performance } from "node:perf_hooks";

import { runOpenWikiAgent } from "../../../src/agent/index.js";
import type { OpenWikiCommand } from "../../../src/agent/types.js";
import { SystemRunError } from "../core/errors.js";
import type { SystemRunOutcome, SystemUnderTest } from "../core/types.js";

/**
 * Options for the OpenWiki system adapter.
 */
export interface OpenWikiSystemOptions {
  /**
   * Provider id OpenWiki should run with. Set into the environment before each
   * run because OpenWiki resolves its provider from `OPENWIKI_PROVIDER`.
   */
  provider: string;

  /**
   * Model id for the system under test, or undefined to let OpenWiki resolve its
   * default for the provider.
   *
   * @default OpenWiki's own default model for the provider
   */
  modelId?: string;
}

/**
 * The baseline System Under Test: today's OpenWiki, driven through its single
 * `runOpenWikiAgent` entrypoint. Passes `outputMode: "repository"` so the
 * worktree `cwd` is honored (without it, OpenWiki ignores `cwd` and writes into
 * the user's local wiki directory), and never passes a user message, so update
 * change-detection is driven purely by the real source deltas between
 * checkpoints.
 */
export class OpenWikiSystem implements SystemUnderTest {
  readonly name = "openwiki-baseline";

  private readonly options: OpenWikiSystemOptions;

  constructor(options: OpenWikiSystemOptions) {
    this.options = options;
  }

  async init(worktreeDir: string): Promise<SystemRunOutcome> {
    return this.run("init", worktreeDir);
  }

  async update(worktreeDir: string): Promise<SystemRunOutcome> {
    return this.run("update", worktreeDir);
  }

  /**
   * Run OpenWiki against a prepared worktree and translate its result into a
   * `SystemRunOutcome`.
   *
   * @param command - The OpenWiki command to run.
   * @param worktreeDir - Absolute path to the prepared worktree.
   *
   * @returns The run outcome.
   *
   * @throws SystemRunError when OpenWiki throws.
   */
  private async run(
    command: OpenWikiCommand,
    worktreeDir: string,
  ): Promise<SystemRunOutcome> {
    process.env.OPENWIKI_PROVIDER = this.options.provider;

    if (this.options.modelId !== undefined) {
      process.env.OPENWIKI_MODEL_ID = this.options.modelId;
    }

    const start = performance.now();

    try {
      const result = await runOpenWikiAgent(command, worktreeDir, {
        outputMode: "repository",
        modelId: this.options.modelId,
      });

      return {
        skipped: result.skipped === true,
        durationMs: Math.round(performance.now() - start),
      };
    } catch (error) {
      throw new SystemRunError(
        `OpenWiki ${command} failed in ${worktreeDir}: ${(error as Error).message}`,
      );
    }
  }
}
