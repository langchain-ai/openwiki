import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Safely writes a file that lives inside a repository OpenWiki is documenting.
 *
 * OpenWiki writes several files into the target repo (the recursive-monorepo
 * manifest/index/state, plus the code-mode workflow and AGENTS.md/CLAUDE.md).
 * Both the destination paths and their contents are attacker-influenced — the
 * repo under documentation is untrusted input — and `writeFile` follows symlinks
 * by default. A malicious repo could commit one of these paths as a symlink to a
 * file outside the repo (e.g. `~/.ssh/authorized_keys` or `~/.bashrc`); running
 * OpenWiki would then follow the link and overwrite that target with generated
 * content (CWE-59). Guard against it before writing:
 *
 * 1. `realpath` the parent directory and refuse if it resolves outside the repo
 *    root — catches a symlinked ancestor directory pointing out of the repo.
 * 2. `lstat` the destination and refuse if it is a symlink (lstat does not
 *    follow the final component), so the write can never follow the link.
 *
 * Throws on a rejected path so a malicious layout fails loudly rather than
 * writing through the link.
 */
export async function writeGeneratedFile(
  repoRoot: string,
  absolutePath: string,
  content: string,
): Promise<void> {
  const parentDir = path.dirname(absolutePath);
  await mkdir(parentDir, { recursive: true });

  const realRepoRoot = await realpath(repoRoot);
  const realParent = await realpath(parentDir);
  const relativeParent = path.relative(realRepoRoot, realParent);
  if (
    relativeParent !== "" &&
    (relativeParent.startsWith("..") || path.isAbsolute(relativeParent))
  ) {
    throw new Error(
      `Refusing to write ${JSON.stringify(
        path.relative(repoRoot, absolutePath),
      )}: its directory resolves outside the repository (symlink escape).`,
    );
  }

  const existing = await lstat(absolutePath).catch(() => null);
  if (existing?.isSymbolicLink()) {
    throw new Error(
      `Refusing to write ${JSON.stringify(
        path.relative(repoRoot, absolutePath),
      )}: the destination is a symlink; writing would follow it and overwrite an arbitrary file.`,
    );
  }

  await writeFile(absolutePath, content, "utf8");
}
