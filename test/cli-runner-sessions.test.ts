import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  cliSessionsPath,
  getCliSession,
  saveCliSession,
} from "../src/agent/cli-runner/sessions.ts";

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "openwiki-cli-sessions-"));
}

describe("cli session store", () => {
  test("returns null when no session file exists", async () => {
    const dir = await makeTempDir();

    expect(await getCliSession("thread-1", "claude-code", dir)).toBe(null);
  });

  test("round-trips a saved session", async () => {
    const dir = await makeTempDir();

    await saveCliSession("thread-1", "claude-code", "session-abc", dir);

    expect(await getCliSession("thread-1", "claude-code", dir)).toBe(
      "session-abc",
    );
  });

  test("does not return sessions recorded for another engine", async () => {
    const dir = await makeTempDir();

    await saveCliSession("thread-1", "claude-code", "session-abc", dir);

    expect(await getCliSession("thread-1", "codex-cli", dir)).toBe(null);
  });

  test("overwrites an existing thread entry", async () => {
    const dir = await makeTempDir();

    await saveCliSession("thread-1", "claude-code", "session-a", dir);
    await saveCliSession("thread-1", "claude-code", "session-b", dir);

    expect(await getCliSession("thread-1", "claude-code", dir)).toBe(
      "session-b",
    );
  });

  test("recovers from a corrupt session file", async () => {
    const dir = await makeTempDir();

    await writeFile(cliSessionsPath(dir), "not json", "utf8");

    expect(await getCliSession("thread-1", "claude-code", dir)).toBe(null);
    await saveCliSession("thread-1", "claude-code", "session-a", dir);
    expect(await getCliSession("thread-1", "claude-code", dir)).toBe(
      "session-a",
    );
  });

  test("persists updatedAt metadata as ISO timestamp", async () => {
    const dir = await makeTempDir();

    await saveCliSession("thread-1", "claude-code", "session-a", dir);
    const raw = JSON.parse(
      await readFile(cliSessionsPath(dir), "utf8"),
    ) as Record<
      string,
      { engine: string; sessionId: string; updatedAt: string }
    >;

    expect(raw["thread-1"].engine).toBe("claude-code");
    expect(Date.parse(raw["thread-1"].updatedAt)).not.toBeNaN();
  });
});
