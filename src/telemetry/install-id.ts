import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";

import { openWikiHomeDir } from "../openwiki-home.js";
import { INSTALL_ID_PATH } from "./config.js";
import { noticeSuppressed } from "./gates.js";

/**
 * Reads the install id, creating it on first use. `isNew` is true only when the
 * id was just minted which is the signal for the one-time notice. The id is a
 * random UUID with no relationship to the user, machine, or repository.
 */
export async function getOrCreateInstallId(): Promise<{
  id: string;
  isNew: boolean;
}> {
  try {
    const existing = (await readFile(INSTALL_ID_PATH, "utf8")).trim();

    if (existing.length > 0) {
      return { id: existing, isNew: false };
    }
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }

  const id = randomUUID();
  await mkdir(openWikiHomeDir, { recursive: true, mode: 0o700 });
  await writeFile(INSTALL_ID_PATH, `${id}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(INSTALL_ID_PATH, 0o600);

  return { id, isNew: true };
}

/**
 * Whether the one-time first-run notice should be shown now: true only on the
 * first run on this machine (install id just minted). Suppressed (returns false,
 * mints no id) when opted out or in CI. Never throws. The caller decides how to
 * render it (an Ink box in the interactive TUI, plain text on stderr for print),
 * so this stays free of presentation. Called at the START of a run so the
 * disclosure precedes any output.
 */
export async function firstRunNoticePending(): Promise<boolean> {
  if (noticeSuppressed()) {
    return false;
  }

  try {
    return (await getOrCreateInstallId()).isNew;
  } catch {
    // Intentionally ignored: telemetry must never break a run.
    return false;
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
