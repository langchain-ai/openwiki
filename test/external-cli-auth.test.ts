import { afterEach, describe, expect, test, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
  spawn: vi.fn(),
}));

import {
  resolveExternalCliCredential,
  validateExternalCliCredential,
} from "../src/external-cli-auth.ts";

afterEach(() => {
  execFileMock.mockReset();
});

describe("external CLI provider credentials", () => {
  test("uses a GitHub CLI credential only for the current process", async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const done = args.at(-1) as
        | ((error: Error | null, stdout: string, stderr: string) => void)
        | undefined;
      // The production `execFile` has a custom promisify implementation
      // returning { stdout, stderr }; mirror that shape in this test double.
      done?.(
        null,
        { stdout: "oauth-token\n", stderr: "" } as unknown as string,
        "",
      );
    });
    const env: NodeJS.ProcessEnv = {};

    const resolved = await resolveExternalCliCredential("copilot", env);

    expect(execFileMock).toHaveBeenCalled();
    expect(resolved).toBe(true);
    expect(env.COPILOT_API_KEY).toBe("oauth-token");
    expect(execFileMock).toHaveBeenCalledWith(
      "gh",
      ["auth", "token"],
      expect.objectContaining({ timeout: 5_000 }),
      expect.any(Function),
    );
  });

  test("preserves an explicitly supplied headless credential", async () => {
    const env: NodeJS.ProcessEnv = { COPILOT_API_KEY: "ci-oauth-token" };

    await expect(resolveExternalCliCredential("copilot", env)).resolves.toBe(
      false,
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test("rejects GitHub personal access tokens with a clear message", () => {
    expect(() =>
      validateExternalCliCredential("copilot", "github_pat_example"),
    ).toThrow(/does not accept Personal Access Tokens/u);
  });
});
