import { cp, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OPEN_WIKI_DIR } from "../config/constants.js";
import { isFileNotFoundError } from "../platform/fs-errors.js";

const REPOSITORY_INSTRUCTIONS = "INSTRUCTIONS.md";
type ReplacementSignal = "SIGINT" | "SIGTERM";
const SIGNAL_EXIT_CODES: Readonly<Record<ReplacementSignal, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
};

/**
 * Recoverable replacement of one existing repository wiki.
 */
export interface RepositoryWikiReplacement {
  /** Discards the private backup after a successful init. */
  commit(): Promise<void>;

  /** Restores the exact pre-init wiki after a failed init. */
  rollback(): Promise<void>;
}

/**
 * Replaces an existing repository wiki with a blank generation target.
 *
 * `INSTRUCTIONS.md` is user-owned control metadata, so it is copied into the
 * blank target. Everything else below `openwiki/` is generated state and is
 * removed before the init agent sees the repository. A private temporary copy
 * remains available until the run either commits or rolls back.
 *
 * SIGINT and SIGTERM restore the backup before exiting. This keeps an operator
 * cancellation from leaving the repository with a partial replacement wiki.
 *
 * A first init with no `openwiki/` directory keeps the existing partial-run
 * recovery behavior and therefore returns a no-op transaction.
 *
 * @param rootDir - Absolute repository root.
 * @returns Transaction controlling the pre-init backup.
 */
export async function beginRepositoryWikiReplacement(
  rootDir: string,
): Promise<RepositoryWikiReplacement> {
  if (!path.isAbsolute(rootDir)) {
    throw new Error("Repository wiki replacement requires an absolute root.");
  }

  const repositoryRoot = path.resolve(rootDir);
  const wikiDir = path.join(repositoryRoot, OPEN_WIKI_DIR);
  const wikiStat = await lstat(wikiDir).catch((error: unknown) => {
    if (isFileNotFoundError(error)) return null;
    throw error;
  });

  if (wikiStat === null) {
    return createNoopReplacement();
  }
  if (!wikiStat.isDirectory() || wikiStat.isSymbolicLink()) {
    throw new Error(
      `Refusing to replace ${OPEN_WIKI_DIR}: expected a real directory below the repository root.`,
    );
  }

  const backupParent = await mkdtemp(path.join(tmpdir(), "openwiki-init-"));
  const backupDir = path.join(backupParent, OPEN_WIKI_DIR);
  let finished = false;
  let finishing: Promise<void> | undefined;
  let initialization: Promise<void> = Promise.resolve();

  const removeSignalHandlers = (): void => {
    process.removeListener("SIGINT", handleSigint);
    process.removeListener("SIGTERM", handleSigterm);
  };

  const restore = async (): Promise<void> => {
    await rm(wikiDir, { force: true, recursive: true });
    await cp(backupDir, wikiDir, {
      preserveTimestamps: true,
      recursive: true,
      verbatimSymlinks: true,
    });
  };

  const finish = (action: "commit" | "rollback"): Promise<void> => {
    if (finishing) return finishing;
    finishing = (async () => {
      try {
        await initialization.catch(() => undefined);
        if (finished) return;
        if (action === "rollback") {
          await restore();
        }
        await rm(backupParent, { force: true, recursive: true });
        finished = true;
      } finally {
        removeSignalHandlers();
      }
    })();
    return finishing;
  };

  const replacement: RepositoryWikiReplacement = {
    commit: () => finish("commit"),
    async rollback() {
      try {
        await finish("rollback");
      } catch (error) {
        throw new Error(
          `Could not restore the previous repository wiki; the backup remains at ${backupDir}.`,
          { cause: error },
        );
      }
    },
  };

  const handleSignal = (signal: ReplacementSignal): void => {
    removeSignalHandlers();
    void replacement
      .rollback()
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
      })
      .finally(() => {
        setImmediate(() => process.exit(SIGNAL_EXIT_CODES[signal]));
      });
  };

  function handleSigint(): void {
    handleSignal("SIGINT");
  }

  function handleSigterm(): void {
    handleSignal("SIGTERM");
  }

  try {
    await cp(wikiDir, backupDir, {
      preserveTimestamps: true,
      recursive: true,
      verbatimSymlinks: true,
    });
  } catch (error) {
    await rm(backupParent, { force: true, recursive: true }).catch(
      () => undefined,
    );
    throw error;
  }

  // Install cancellation recovery before the first destructive operation. If a
  // signal arrives while replacement I/O is pending, rollback waits for that I/O
  // to settle before restoring the complete backup.
  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);

  initialization = (async () => {
    await rm(wikiDir, { force: true, recursive: true });
    await mkdir(wikiDir, { recursive: true });

    const instructions = path.join(backupDir, REPOSITORY_INSTRUCTIONS);
    const instructionsStat = await lstat(instructions).catch(
      (error: unknown) => {
        if (isFileNotFoundError(error)) return null;
        throw error;
      },
    );
    if (instructionsStat) {
      if (!instructionsStat.isFile() || instructionsStat.isSymbolicLink()) {
        throw new Error(
          `Refusing to preserve ${OPEN_WIKI_DIR}/${REPOSITORY_INSTRUCTIONS}: expected a regular file.`,
        );
      }
      await cp(instructions, path.join(wikiDir, REPOSITORY_INSTRUCTIONS), {
        preserveTimestamps: true,
      });
    }
  })();

  try {
    await initialization;
  } catch (error) {
    try {
      await replacement.rollback();
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Repository wiki replacement failed and rollback was incomplete; the backup remains at ${backupDir}.`,
        { cause: rollbackError },
      );
    }
    throw error;
  }

  return replacement;
}

/** Returns an idempotent transaction for a first init with no prior wiki. */
function createNoopReplacement(): RepositoryWikiReplacement {
  return {
    commit: () => Promise.resolve(),
    rollback: () => Promise.resolve(),
  };
}
