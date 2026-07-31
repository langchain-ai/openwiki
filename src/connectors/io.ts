import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  ensureConnectorHome,
  getConnectorConfigPath,
  getConnectorRawDir,
  getConnectorStatePath,
} from "../openwiki-home.js";
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

const stateUpdateQueues = new Map<ConnectorId, Promise<void>>();

/** Read, transform, and atomically commit connector state as one local transaction. */
export async function updateConnectorState(
  connectorId: ConnectorId,
  updater: (state: ConnectorState) => ConnectorState | Promise<ConnectorState>,
): Promise<ConnectorState> {
  const previous = stateUpdateQueues.get(connectorId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  stateUpdateQueues.set(connectorId, current);

  await previous;
  try {
    const nextState = await updater(await readConnectorState(connectorId));
    await writeConnectorState(connectorId, nextState);
    return nextState;
  } finally {
    release();
    if (stateUpdateQueues.get(connectorId) === current) {
      stateUpdateQueues.delete(connectorId);
    }
  }
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
  return `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`;
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

async function writePrivateJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 }),
  );
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, filePath);
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
