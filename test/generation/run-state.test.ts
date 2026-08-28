import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RepositoryRunError } from "../../src/generation/errors.ts";
import {
  readRepositoryRunState,
  removeRepositoryRunState,
  repositoryRunStatePath,
  writeRepositoryRunState,
  type RepositoryRunState,
} from "../../src/generation/run-state.ts";

let root: string;

/**
 * Builds one complete valid checkpoint for persistence tests.
 */
function createRunState(): RepositoryRunState {
  return {
    schemaVersion: 1,
    runId: "11111111-1111-4111-8111-111111111111",
    mode: "update",
    phase: "generating",
    startedAt: "2026-08-24T12:00:00.000Z",
    language: "en",
    languageChanged: false,
    requiredRewritePages: [],
    initialPages: ["/openwiki/quickstart.md"],
    sourceFingerprint: `sha256:${"a".repeat(64)}`,
    targetGitHead: "0123456789abcdef",
    planningContext: "Preserve the public API examples.",
    actor: {
      producerActor: "host-agent/codex",
      metadataModel: "gpt-5.6-sol",
    },
    previousLastUpdate: {
      updatedAt: "2026-08-23T12:00:00.000Z",
      command: "update",
      gitHead: "0123456789abcdef",
      model: "gpt-5.5",
      status: "complete",
      language: "en",
    },
    baseGitHead: "0123456789abcdef",
    wikiGoal: "Document stable repository behavior.",
    beforeContentSnapshot: "before-snapshot",
    preparedWiki: {
      generatedProvenance: [
        {
          page: "/openwiki/quickstart.md",
          bodyHash: "body-hash",
          generated: {
            by: "openwiki/0.3.3",
            at: "2026-08-23T12:00:00.000Z",
          },
        },
      ],
    },
    plan: {
      pages: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          path: "/openwiki/quickstart.md",
          title: "Quickstart",
          purpose: "Explain repository entry points.",
          seedPaths: ["src/index.ts"],
          relatedPages: [],
          instructions: ["Keep examples concise."],
          status: "pending",
        },
      ],
      deletePages: [],
    },
  };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "openwiki-run-state-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("repository run-state persistence", () => {
  test("atomically writes and reads the complete checkpoint", async () => {
    const state = createRunState();

    await writeRepositoryRunState(root, state);

    expect(await readRepositoryRunState(root)).toEqual(state);
    expect(await readFile(repositoryRunStatePath(root), "utf8")).toBe(
      `${JSON.stringify(state, null, 2)}\n`,
    );
    expect(
      (await readdir(path.join(root, "openwiki"))).filter((entry) =>
        entry.endsWith(".tmp"),
      ),
    ).toEqual([]);
  });

  test("does not replace durable state when validation fails", async () => {
    const state = createRunState();
    await writeRepositoryRunState(root, state);

    const invalid = {
      ...state,
      schemaVersion: 2,
    } as unknown as RepositoryRunState;

    await expect(writeRepositoryRunState(root, invalid)).rejects.toThrow();
    expect(await readRepositoryRunState(root)).toEqual(state);
  });

  test("preserves the target and removes its temporary file when rename fails", async () => {
    const target = repositoryRunStatePath(root);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "marker"), "preserved\n", "utf8");

    await expect(
      writeRepositoryRunState(root, createRunState()),
    ).rejects.toThrow();

    expect(await readFile(path.join(target, "marker"), "utf8")).toBe(
      "preserved\n",
    );
    expect(
      (await readdir(path.join(root, "openwiki"))).filter((entry) =>
        entry.endsWith(".tmp"),
      ),
    ).toEqual([]);
  });

  test("rejects malformed and schema-extended checkpoints as resumable-state errors", async () => {
    const target = repositoryRunStatePath(root);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "{not-json\n", "utf8");

    await expect(readRepositoryRunState(root)).rejects.toMatchObject({
      code: "invalid_state",
    } satisfies Partial<RepositoryRunError>);

    await writeFile(
      target,
      `${JSON.stringify({ ...createRunState(), unexpected: true })}\n`,
      "utf8",
    );
    await expect(readRepositoryRunState(root)).rejects.toMatchObject({
      code: "invalid_state",
    } satisfies Partial<RepositoryRunError>);
  });

  test("returns null when absent and removes the checkpoint idempotently", async () => {
    expect(await readRepositoryRunState(root)).toBeNull();

    await writeRepositoryRunState(root, createRunState());
    await removeRepositoryRunState(root);
    await removeRepositoryRunState(root);

    expect(await readRepositoryRunState(root)).toBeNull();
  });
});
