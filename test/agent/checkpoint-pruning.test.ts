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
});
