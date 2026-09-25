import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Well-known SID for NT AUTHORITY\SYSTEM; the * prefix tells icacls it is a
// SID rather than an account name, so it resolves on any display language.
const SYSTEM_SID = "*S-1-5-18";

/**
 * Mirrors the POSIX 0o700 owner-only intent on Windows, where fs.chmod only
 * toggles the read-only attribute and leaves ACLs untouched: grants full
 * control to the current user and SYSTEM (inheritable, so new children are
 * covered), then removes inherited ACEs. The grant runs before the
 * inheritance reset so a failed grant can never lock the user out of the
 * directory. Best-effort by design: returns false instead of throwing so
 * ACL tooling problems never block a run. No-op on non-Windows platforms.
 */
export async function restrictDirToCurrentUser(
  dirPath: string,
): Promise<boolean> {
  if (process.platform !== "win32") {
    return false;
  }

  const userName = os.userInfo().username;

  try {
    await execFileAsync("icacls", [
      dirPath,
      "/grant:r",
      `${userName}:(OI)(CI)F`,
      `${SYSTEM_SID}:(OI)(CI)F`,
    ]);
    await execFileAsync("icacls", [dirPath, "/inheritance:r"]);
    return true;
  } catch {
    return false;
  }
}
