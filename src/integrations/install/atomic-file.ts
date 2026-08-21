import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Atomically replaces one UTF-8 text file while preserving existing mode bits.
 *
 * @param filePath - Absolute destination path.
 * @param content - Complete replacement content.
 */
export async function writeTextAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const mode = await lstat(filePath)
    .then((file) => file.mode & 0o777)
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0o644;
      throw error;
    });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(temporary, content, { encoding: "utf8", mode });
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
