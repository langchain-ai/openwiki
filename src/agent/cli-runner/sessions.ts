import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { openWikiEnvDir } from "../../env.js";
import { isFileNotFoundError } from "../../fs-errors.js";

const CLI_SESSIONS_FILENAME = "cli-sessions.json";

type CliSessionEntry = {
  engine: string;
  sessionId: string;
  updatedAt: string;
};

type CliSessionMap = Record<string, CliSessionEntry>;

export function cliSessionsPath(baseDir: string = openWikiEnvDir): string {
  return path.join(baseDir, CLI_SESSIONS_FILENAME);
}

export async function getCliSession(
  threadId: string,
  engine: string,
  baseDir: string = openWikiEnvDir,
): Promise<string | null> {
  const sessions = await readSessions(baseDir);
  const entry = sessions[threadId];

  return entry && entry.engine === engine ? entry.sessionId : null;
}

export async function saveCliSession(
  threadId: string,
  engine: string,
  sessionId: string,
  baseDir: string = openWikiEnvDir,
): Promise<void> {
  const sessions = await readSessions(baseDir);

  sessions[threadId] = {
    engine,
    sessionId,
    updatedAt: new Date().toISOString(),
  };

  const filePath = cliSessionsPath(baseDir);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(sessions, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  // Also chmod: writeFile's mode only applies when creating a new file, so an
  // existing (possibly wider) file keeps its permissions without this.
  await chmod(filePath, 0o600);
}

async function readSessions(baseDir: string): Promise<CliSessionMap> {
  let content: string;

  try {
    content = await readFile(cliSessionsPath(baseDir), "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return {};
    }

    throw error;
  }

  try {
    const parsed: unknown = JSON.parse(content);

    return isCliSessionMap(parsed) ? parsed : {};
  } catch {
    // Corrupt session cache: start over instead of failing the run.
    return {};
  }
}

function isCliSessionMap(value: unknown): value is CliSessionMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as CliSessionEntry).engine === "string" &&
      typeof (entry as CliSessionEntry).sessionId === "string",
  );
}
