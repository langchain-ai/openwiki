import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { describe, expect, test } from "vitest";
import { pruneCheckpointHistory } from "../../src/agent/index.ts";

describe("pruneCheckpointHistory", () => {
  test("keeps only the latest checkpoint per thread/namespace and leaves other threads untouched", async () => {
    const checkpointer = SqliteSaver.fromConnString(":memory:");

    // Trigger the checkpointer's lazy table creation.
    await checkpointer.getTuple({
      configurable: { thread_id: "thread-a", checkpoint_ns: "" },
    });

    const insertCheckpoint = checkpointer.db.prepare(
      `INSERT INTO checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
       VALUES (?, ?, ?, ?, 'json', '{}', '{}')`,
    );
    const insertWrite = checkpointer.db.prepare(
      `INSERT INTO writes
         (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
       VALUES (?, ?, ?, 'task', 0, 'messages', 'json', '{}')`,
    );

    insertCheckpoint.run("thread-a", "", "c1", null);
    insertCheckpoint.run("thread-a", "", "c2", "c1");
    insertCheckpoint.run("thread-a", "", "c3", "c2");
    insertCheckpoint.run("thread-a", "sub:1", "s1", null);
    insertCheckpoint.run("thread-a", "sub:1", "s2", "s1");
    insertCheckpoint.run("thread-b", "", "b1", null);
    insertCheckpoint.run("thread-b", "", "b2", "b1");

    for (const [threadId, ns, checkpointId] of [
      ["thread-a", "", "c1"],
      ["thread-a", "", "c2"],
      ["thread-a", "", "c3"],
      ["thread-a", "sub:1", "s1"],
      ["thread-a", "sub:1", "s2"],
      ["thread-b", "", "b1"],
      ["thread-b", "", "b2"],
    ]) {
      insertWrite.run(threadId, ns, checkpointId);
    }

    pruneCheckpointHistory(checkpointer, "thread-a");

    const remainingCheckpoints = checkpointer.db
      .prepare(
        "SELECT thread_id, checkpoint_ns, checkpoint_id FROM checkpoints ORDER BY thread_id, checkpoint_ns, checkpoint_id",
      )
      .all();

    expect(remainingCheckpoints).toEqual([
      { thread_id: "thread-a", checkpoint_ns: "", checkpoint_id: "c3" },
      { thread_id: "thread-a", checkpoint_ns: "sub:1", checkpoint_id: "s2" },
      { thread_id: "thread-b", checkpoint_ns: "", checkpoint_id: "b1" },
      { thread_id: "thread-b", checkpoint_ns: "", checkpoint_id: "b2" },
    ]);

    const remainingWrites = checkpointer.db
      .prepare(
        "SELECT thread_id, checkpoint_ns, checkpoint_id FROM writes ORDER BY thread_id, checkpoint_ns, checkpoint_id",
      )
      .all();

    expect(remainingWrites).toEqual([
      // c2's and s1's write rows survive because the retained checkpoints
      // (c3 and s2) each point back to them as their parent_checkpoint_id.
      { thread_id: "thread-a", checkpoint_ns: "", checkpoint_id: "c2" },
      { thread_id: "thread-a", checkpoint_ns: "", checkpoint_id: "c3" },
      { thread_id: "thread-a", checkpoint_ns: "sub:1", checkpoint_id: "s1" },
      { thread_id: "thread-a", checkpoint_ns: "sub:1", checkpoint_id: "s2" },
      { thread_id: "thread-b", checkpoint_ns: "", checkpoint_id: "b1" },
      { thread_id: "thread-b", checkpoint_ns: "", checkpoint_id: "b2" },
    ]);
  });

  test("safely no-ops when checkpoint tables do not exist yet", () => {
    const checkpointer = SqliteSaver.fromConnString(":memory:");
    expect(() => pruneCheckpointHistory(checkpointer)).not.toThrow();
    expect(() =>
      pruneCheckpointHistory(checkpointer, "any-thread"),
    ).not.toThrow();
  });

  test("prunes all threads when threadId is omitted", async () => {
    const checkpointer = SqliteSaver.fromConnString(":memory:");

    // Trigger lazy table creation.
    await checkpointer.getTuple({
      configurable: { thread_id: "init", checkpoint_ns: "" },
    });

    const insertCheckpoint = checkpointer.db.prepare(
      `INSERT INTO checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
       VALUES (?, ?, ?, ?, 'json', '{}', '{}')`,
    );
    const insertWrite = checkpointer.db.prepare(
      `INSERT INTO writes
         (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
       VALUES (?, ?, ?, 'task', 0, 'messages', 'json', '{}')`,
    );

    insertCheckpoint.run("thread-a", "", "a1", null);
    insertCheckpoint.run("thread-a", "", "a2", "a1");
    insertCheckpoint.run("thread-a", "", "a3", "a2");
    insertCheckpoint.run("thread-a", "sub:1", "s1", null);
    insertCheckpoint.run("thread-a", "sub:1", "s2", "s1");
    insertCheckpoint.run("thread-b", "", "b1", null);
    insertCheckpoint.run("thread-b", "", "b2", "b1");
    insertCheckpoint.run("thread-b", "", "b3", "b2");

    for (const [threadId, ns, checkpointId] of [
      ["thread-a", "", "a1"],
      ["thread-a", "", "a2"],
      ["thread-a", "", "a3"],
      ["thread-a", "sub:1", "s1"],
      ["thread-a", "sub:1", "s2"],
      ["thread-b", "", "b1"],
      ["thread-b", "", "b2"],
      ["thread-b", "", "b3"],
    ]) {
      insertWrite.run(threadId, ns, checkpointId);
    }

    // Call pruneCheckpointHistory without threadId.
    pruneCheckpointHistory(checkpointer);

    const remainingCheckpoints = checkpointer.db
      .prepare(
        "SELECT thread_id, checkpoint_ns, checkpoint_id FROM checkpoints ORDER BY thread_id, checkpoint_ns, checkpoint_id",
      )
      .all();

    expect(remainingCheckpoints).toEqual([
      { thread_id: "thread-a", checkpoint_ns: "", checkpoint_id: "a3" },
      { thread_id: "thread-a", checkpoint_ns: "sub:1", checkpoint_id: "s2" },
      { thread_id: "thread-b", checkpoint_ns: "", checkpoint_id: "b3" },
    ]);

    const remainingWrites = checkpointer.db
      .prepare(
        "SELECT thread_id, checkpoint_ns, checkpoint_id FROM writes ORDER BY thread_id, checkpoint_ns, checkpoint_id",
      )
      .all();

    expect(remainingWrites).toEqual([
      { thread_id: "thread-a", checkpoint_ns: "", checkpoint_id: "a2" },
      { thread_id: "thread-a", checkpoint_ns: "", checkpoint_id: "a3" },
      { thread_id: "thread-a", checkpoint_ns: "sub:1", checkpoint_id: "s1" },
      { thread_id: "thread-a", checkpoint_ns: "sub:1", checkpoint_id: "s2" },
      { thread_id: "thread-b", checkpoint_ns: "", checkpoint_id: "b2" },
      { thread_id: "thread-b", checkpoint_ns: "", checkpoint_id: "b3" },
    ]);
  });

  test("prunes unpruned checkpoints from a killed process on next startup", async () => {
    const tempDir = await mkdtemp(
      path.join(tmpdir(), "openwiki-checkpoint-test-"),
    );
    const dbPath = path.join(tempDir, "openwiki.sqlite");

    try {
      // Step 1: Simulate a killed run writing checkpoints without reaching finally.
      const initialSaver = SqliteSaver.fromConnString(dbPath);
      await initialSaver.getTuple({
        configurable: { thread_id: "killed-thread", checkpoint_ns: "" },
      });

      const insertCheckpoint = initialSaver.db.prepare(
        `INSERT INTO checkpoints
           (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
         VALUES (?, ?, ?, ?, 'json', '{}', '{}')`,
      );
      for (let i = 1; i <= 20; i++) {
        insertCheckpoint.run(
          "killed-thread",
          "",
          `c${i.toString().padStart(2, "0")}`,
          i > 1 ? `c${(i - 1).toString().padStart(2, "0")}` : null,
        );
      }
      // Simulate process kill (no pruneCheckpointHistory called).
      initialSaver.db.close();

      // Step 2: Next run starts up and opens the persistent checkpointer.
      const reopenedSaver = SqliteSaver.fromConnString(dbPath);
      pruneCheckpointHistory(reopenedSaver);

      const rows = reopenedSaver.db
        .prepare("SELECT thread_id, checkpoint_id FROM checkpoints")
        .all();

      expect(rows).toEqual([
        { thread_id: "killed-thread", checkpoint_id: "c20" },
      ]);
      reopenedSaver.db.close();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
