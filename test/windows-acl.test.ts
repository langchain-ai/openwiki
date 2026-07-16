import os from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";

const execFileMock = vi.hoisted(() =>
  vi.fn(
    (
      _command: string,
      _args: string[],
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callback(null, "", "");
    },
  ),
);

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import { restrictDirToCurrentUser } from "../src/windows-acl.ts";

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

afterEach(() => {
  setPlatform(realPlatform);
  execFileMock.mockClear();
});

describe("restrictDirToCurrentUser", () => {
  test("is a no-op on non-Windows platforms", async () => {
    setPlatform("linux");

    const restricted = await restrictDirToCurrentUser("/home/user/.openwiki");

    expect(restricted).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test("grants the current user and SYSTEM, then removes inheritance", async () => {
    setPlatform("win32");

    const restricted = await restrictDirToCurrentUser(
      "C:\\Users\\u\\.openwiki",
    );

    expect(restricted).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(2);

    const [grantCommand, grantArgs] = execFileMock.mock.calls[0] as unknown as [
      string,
      string[],
    ];
    expect(grantCommand).toBe("icacls");
    expect(grantArgs).toEqual([
      "C:\\Users\\u\\.openwiki",
      "/grant:r",
      `${os.userInfo().username}:(OI)(CI)F`,
      "*S-1-5-18:(OI)(CI)F",
    ]);

    const [, inheritanceArgs] = execFileMock.mock.calls[1] as unknown as [
      string,
      string[],
    ];
    expect(inheritanceArgs).toEqual([
      "C:\\Users\\u\\.openwiki",
      "/inheritance:r",
    ]);
  });

  test("does not remove inheritance when the grant fails, so a failed grant cannot lock the user out", async () => {
    setPlatform("win32");
    execFileMock.mockImplementationOnce(
      (
        _command: string,
        _args: string[],
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(new Error("icacls failed"), "", "");
      },
    );

    const restricted = await restrictDirToCurrentUser(
      "C:\\Users\\u\\.openwiki",
    );

    expect(restricted).toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});
