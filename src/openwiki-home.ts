import { chmod, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const openWikiHomeDir = path.join(os.homedir(), ".openwiki");
export const openWikiConnectorsDir = path.join(openWikiHomeDir, "connectors");
export const openWikiLocalWikiDir = path.join(openWikiHomeDir, "wiki");
export const openWikiSkillsDir = path.join(openWikiHomeDir, "skills");

export function getConnectorDir(connectorId: string): string {
  return path.join(openWikiConnectorsDir, connectorId);
}

export function getConnectorConfigPath(connectorId: string): string {
  return path.join(getConnectorDir(connectorId), "config.json");
}

export function getConnectorStatePath(connectorId: string): string {
  return path.join(getConnectorDir(connectorId), "state.json");
}

export function getConnectorRawDir(connectorId: string): string {
  return path.join(getConnectorDir(connectorId), "raw");
}

export function getConnectorLogsDir(connectorId: string): string {
  return path.join(getConnectorDir(connectorId), "logs");
}

export async function ensureOpenWikiHome(): Promise<void> {
  await mkdir(openWikiHomeDir, { recursive: true, mode: 0o700 });
  await chmodIfExists(openWikiHomeDir, 0o700);
  await mkdir(openWikiConnectorsDir, { recursive: true, mode: 0o700 });
  await mkdir(openWikiLocalWikiDir, { recursive: true, mode: 0o700 });
  await mkdir(openWikiSkillsDir, { recursive: true, mode: 0o700 });
}

export async function ensureConnectorHome(connectorId: string): Promise<void> {
  assertSafeConnectorId(connectorId);
  await ensureOpenWikiHome();
  await mkdir(getConnectorDir(connectorId), { recursive: true, mode: 0o700 });
  await mkdir(getConnectorRawDir(connectorId), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(getConnectorLogsDir(connectorId), {
    recursive: true,
    mode: 0o700,
  });
}

export function assertSafeConnectorId(connectorId: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(connectorId)) {
    throw new Error(`Invalid connector ID: ${connectorId}`);
  }
}

export function resolveConnectorRawPath(
  connectorId: string,
  relativePath: string,
): string {
  assertSafeConnectorId(connectorId);
  const rawDir = getConnectorRawDir(connectorId);
  const resolved = path.resolve(rawDir, relativePath);

  if (resolved !== rawDir && !resolved.startsWith(`${rawDir}${path.sep}`)) {
    throw new Error(
      "Raw item path must stay inside the connector raw directory.",
    );
  }

  return resolved;
}

async function chmodIfExists(filePath: string, mode: number): Promise<void> {
  try {
    await chmod(filePath, mode);
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
