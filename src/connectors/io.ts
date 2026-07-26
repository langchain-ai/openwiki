import { chmod, readFile, writeFile } from "node:fs/promises";
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
  const configPath = getConnectorConfigPath(connectorId);

  let rawConfig: string;

  try {
    rawConfig = await readFile(configPath, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return defaultConfig;
    }

    throw new Error(
      `Failed to read connector config for ${connectorId} at ${configPath}: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }

  let parsedConfig: unknown;
  try {
    parsedConfig = JSON.parse(rawConfig);
  } catch (error) {
    throw new Error(
      `Invalid JSON in connector config for ${connectorId} at ${configPath}: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }

  if (!isJsonObject(parsedConfig)) {
    throw new Error(
      `Invalid connector config for ${connectorId} at ${configPath}: expected a JSON object.`,
    );
  }

  return {
    ...defaultConfig,
    ...parsedConfig,
  };
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

async function writePrivateJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 }),
  );
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(filePath, 0o600);
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
