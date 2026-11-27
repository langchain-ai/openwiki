import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  enableCheckpointAutoVacuum,
  isCheckpointAutoVacuumEnabled,
  pruneCheckpointHistory,
} from "../../src/agent/index.ts";

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

describe("checkpoint database size", () => {
  const AUTO_VACUUM_INCREMENTAL = 2;
  const AUTO_VACUUM_NONE = 0;

  async function withCheckpointFile(
    run: (filePath: string) => Promise<void>,
  ): Promise<void> {
    const filePath = path.join(
      await mkdtemp(path.join(tmpdir(), "openwiki-checkpoint-")),
      "openwiki.sqlite",
    );

    try {
      await run(filePath);
    } finally {
      await rm(filePath, { force: true });
    }
  }

  // Regression for #1030: a prune used to leave every page it freed on the
  // freelist, so openwiki.sqlite only ever grew.
  test("a prune returns the freed pages to the database", async () => {
    await withCheckpointFile(async (filePath) => {
      const checkpointer = SqliteSaver.fromConnString(filePath);
      enableCheckpointAutoVacuum(checkpointer);

      expect(checkpointer.db.pragma("auto_vacuum", { simple: true })).toBe(
        AUTO_VACUUM_INCREMENTAL,
      );

      await checkpointer.getTuple({
        configurable: { thread_id: "thread-a", checkpoint_ns: "" },
      });

      const insertCheckpoint = checkpointer.db.prepare(
        `INSERT INTO checkpoints
           (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
         VALUES ('thread-a', '', ?, NULL, 'json', ?, '{}')`,
      );
      const insertWrite = checkpointer.db.prepare(
        `INSERT INTO writes
           (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
         VALUES ('thread-a', '', ?, 'task', 0, 'messages', 'json', ?)`,
      );

      // Kept under the bound reclaimCheckpointPages vacuums per call, so the
      // assertion below is about one prune fully reclaiming its own deletes.
      for (let index = 0; index < 50; index += 1) {
        const id = `c${index}`;
        insertCheckpoint.run(id, Buffer.alloc(64 * 1024, index % 251));
        insertWrite.run(id, Buffer.alloc(64 * 1024, index % 241));
      }

      // Page count, not file size: SqliteSaver runs in WAL mode, so the
      // freed space leaves the database when the WAL is checkpointed.
      const pagesBefore = checkpointer.db.pragma("page_count", {
        simple: true,
      });
      expect(checkpointer.db.pragma("freelist_count", { simple: true })).toBe(
        0,
      );

      pruneCheckpointHistory(checkpointer, "thread-a");

      expect(checkpointer.db.pragma("freelist_count", { simple: true })).toBe(
        0,
      );
      expect(
        checkpointer.db.pragma("page_count", { simple: true }),
      ).toBeLessThan(pagesBefore);

      checkpointer.db.close();
    });
  });

  // The mode is only recorded while the database has no tables, so
  // createCheckpointer has to set it before the first checkpoint is read.
  test("the mode survives a reopen", async () => {
    await withCheckpointFile(async (filePath) => {
      const created = SqliteSaver.fromConnString(filePath);
      enableCheckpointAutoVacuum(created);

      await created.getTuple({
        configurable: { thread_id: "thread-a", checkpoint_ns: "" },
      });
      created.db.close();

      const reopened = SqliteSaver.fromConnString(filePath);
      expect(reopened.db.pragma("auto_vacuum", { simple: true })).toBe(
        AUTO_VACUUM_INCREMENTAL,
      );
      reopened.db.close();
    });
  });

  // The gap the fresh-database tests above cannot see: a database the old
  // code created keeps auto_vacuum = 0, because sqlite refuses the change
  // once there are tables. Those are the files in #1029.
  test("a database created before this fix reports that the pragma did not take", async () => {
    await withCheckpointFile(async (filePath) => {
      const legacy = SqliteSaver.fromConnString(filePath);
      await legacy.getTuple({
        configurable: { thread_id: "thread-a", checkpoint_ns: "" },
      });
      legacy.db.close();

      const reopened = SqliteSaver.fromConnString(filePath);
      expect(reopened.db.pragma("auto_vacuum", { simple: true })).toBe(
        AUTO_VACUUM_NONE,
      );
      expect(enableCheckpointAutoVacuum(reopened)).toBe(false);
      expect(isCheckpointAutoVacuumEnabled(reopened)).toBe(false);
      reopened.db.close();
    });
  });

  // ...and a prune on it reclaims nothing, which is the whole reason the
  // caller has to say something rather than let the fix read as working.
  test("a prune on a legacy database leaves its freed pages on the freelist", async () => {
    await withCheckpointFile(async (filePath) => {
      const legacy = SqliteSaver.fromConnString(filePath);
      await legacy.getTuple({
        configurable: { thread_id: "thread-a", checkpoint_ns: "" },
      });

      const insertCheckpoint = legacy.db.prepare(
        `INSERT INTO checkpoints
           (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
         VALUES ('thread-a', '', ?, NULL, 'json', ?, '{}')`,
      );
      for (let index = 0; index < 50; index += 1) {
        insertCheckpoint.run(`c${index}`, Buffer.alloc(64 * 1024, index % 251));
      }

      const pagesBefore = legacy.db.pragma("page_count", { simple: true });
      pruneCheckpointHistory(legacy, "thread-a");

      // Rows are gone, pages are not: the space is freed to sqlite and
      // stays with it.
      expect(
        legacy.db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get(),
      ).toEqual({ n: 1 });
      expect(legacy.db.pragma("freelist_count", { simple: true })).toBeGreaterThan(
        0,
      );
      expect(legacy.db.pragma("page_count", { simple: true })).toBe(
        pagesBefore,
      );
      legacy.db.close();
    });
  });

  // The documented one-time migration does convert a legacy file, so the
  // hint in the warning is not advice we have not checked.
  test("the documented VACUUM converts a legacy database", async () => {
    await withCheckpointFile(async (filePath) => {
      const legacy = SqliteSaver.fromConnString(filePath);
      await legacy.getTuple({
        configurable: { thread_id: "thread-a", checkpoint_ns: "" },
      });
      const insertCheckpoint = legacy.db.prepare(
        `INSERT INTO checkpoints
           (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
         VALUES ('thread-a', '', ?, NULL, 'json', ?, '{}')`,
      );
      for (let index = 0; index < 50; index += 1) {
        insertCheckpoint.run(`c${index}`, Buffer.alloc(64 * 1024, index % 251));
      }
      expect(enableCheckpointAutoVacuum(legacy)).toBe(false);

      legacy.db.exec("PRAGMA auto_vacuum = INCREMENTAL; VACUUM;");
      expect(isCheckpointAutoVacuumEnabled(legacy)).toBe(true);

      const pagesBefore = legacy.db.pragma("page_count", { simple: true });
      pruneCheckpointHistory(legacy, "thread-a");
      expect(legacy.db.pragma("page_count", { simple: true })).toBeLessThan(
        pagesBefore,
      );
      legacy.db.close();
    });
  });
});
