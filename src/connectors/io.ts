import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  ensureConnectorHome,
  getConnectorConfigPath,
  getConnectorRawDir,
  getConnectorStatePath,
} from "../config/openwiki-home.js";
import type { ConnectorId, ConnectorState } from "./types.js";

export async function readConnectorConfig<T extends object>(
  connectorId: ConnectorId,
  defaultConfig: T,
): Promise<T> {
  await ensureConnectorHome(connectorId);

  try {
    return {
      ...defaultConfig,
      ...(JSON.parse(
        await readFile(getConnectorConfigPath(connectorId), "utf8"),
      ) as T),
    };
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return defaultConfig;
    }

    throw error;
  }
}

export async function readConnectorState(
  connectorId: ConnectorId,
): Promise<ConnectorState> {
  await ensureConnectorHome(connectorId);

  try {
    return JSON.parse(
      await readFile(getConnectorStatePath(connectorId), "utf8"),
    ) as ConnectorState;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return { version: 1 };
    }

    throw error;
  }
}

export async function writeConnectorState(
  connectorId: ConnectorId,
  state: ConnectorState,
): Promise<void> {
  await ensureConnectorHome(connectorId);
  await writePrivateJson(getConnectorStatePath(connectorId), state);
}

export async function writeRawJson(
  connectorId: ConnectorId,
  runId: string,
  filename: string,
  value: unknown,
): Promise<string> {
  await ensureConnectorHome(connectorId);
  const filePath = path.join(getConnectorRawDir(connectorId), runId, filename);
  await writePrivateJson(filePath, value);

  return filePath;
}

export function createRunId(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

export function updateStateWithRun(
  state: ConnectorState,
  run: NonNullable<ConnectorState["runs"]>[number],
): ConnectorState {
  return {
    ...state,
    lastRunAt: run.at,
    runs: [run, ...(state.runs ?? [])].slice(0, 20),
    version: 1,
  };
}

/**
 * Writes JSON to a private (0o600) file atomically and durably: the content is
 * written to a temporary sibling, flushed to disk, and then renamed into
 * place. The destination path therefore only ever becomes visible with
 * complete content, so readers racing the write (for example the synthesis
 * agent reading a raw dump the connector just reported) can never observe a
 * partial file, and the write is on disk before the path is reported.
 */
async function writePrivateJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  const directoryPath = path.dirname(filePath);
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });

  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  const fileHandle = await open(tempPath, "wx", 0o600);

  try {
    await fileHandle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fileHandle.sync();
  } catch (error) {
    await fileHandle.close();
    await rm(tempPath, { force: true });
    throw error;
  }

  await fileHandle.close();

  try {
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }

  await chmod(filePath, 0o600);
  await syncDirectory(directoryPath);
}

/**
 * Flushes a directory so a just-renamed entry survives a crash and is visible
 * to other readers of the directory. Best effort: directory fsync is not
 * supported on some platforms (notably Windows), where the rename above is
 * still atomic.
 */
async function syncDirectory(directoryPath: string): Promise<void> {
  try {
    const directoryHandle = await open(directoryPath, "r");

    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    // Ignore: opening or fsyncing a directory is platform-dependent.
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
