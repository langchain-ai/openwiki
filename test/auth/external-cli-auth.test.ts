import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
  spawn: spawnMock,
}));

import {
  detectExternalCliCredential,
  getExternalCliAuthAdapter,
  isExternalCliAvailable,
  resolveExternalCliCredential,
  runExternalCliLogin,
  validateExternalCliCredential,
} from "../../src/auth/external-cli-auth.ts";

/**
 * Drives `execFile`'s Node callback to resolve with `stdout`. The production
 * `execFileAsync` is `promisify(execFile)`; with a plain mock (no
 * `promisify.custom`) it resolves with whatever is passed as the second
 * callback argument, so the fake mirrors the `{ stdout }` shape the code
 * destructures.
 */
function execFileResolves(stdout: string): void {
  execFileMock.mockImplementation((...args: unknown[]) => {
    const done = args.at(-1) as
      | ((error: Error | null, stdout: string, stderr: string) => void)
      | undefined;
    done?.(null, { stdout, stderr: "" } as unknown as string, "");
  });
}

/**
 * Drives `execFile`'s Node callback to fail, standing in for a missing CLI or a
 * `gh auth token` invocation on a machine with no active session.
 */
function execFileRejects(): void {
  execFileMock.mockImplementation((...args: unknown[]) => {
    const done = args.at(-1) as
      | ((error: Error | null, stdout: string, stderr: string) => void)
      | undefined;
    done?.(new Error("command failed"), "", "");
  });
}

afterEach(() => {
  execFileMock.mockReset();
  spawnMock.mockReset();
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
      ["auth", "token", "--hostname", "github.com"],
      expect.objectContaining({ timeout: 5_000 }),
      expect.any(Function),
    );
  });

  test("targets the tenant hostname when COPILOT_BASE_URL points at a GHE.com host", () => {
    const env: NodeJS.ProcessEnv = {
      COPILOT_BASE_URL: "https://acme.ghe.com/api/copilot",
    };

    const adapter = getExternalCliAuthAdapter("copilot", env);

    expect(adapter?.commandArgs).toEqual([
      "auth",
      "login",
      "--hostname",
      "acme.ghe.com",
    ]);
    expect(adapter?.tokenArgs).toEqual([
      "auth",
      "token",
      "--hostname",
      "acme.ghe.com",
    ]);
  });

  test("falls back to github.com for an unparseable COPILOT_BASE_URL", () => {
    const env: NodeJS.ProcessEnv = { COPILOT_BASE_URL: "not-a-url" };

    const adapter = getExternalCliAuthAdapter("copilot", env);

    expect(adapter?.tokenArgs).toEqual([
      "auth",
      "token",
      "--hostname",
      "github.com",
    ]);
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

describe("isExternalCliAvailable", () => {
  test("reports true when the CLI answers `--version`", async () => {
    execFileResolves("gh version 2.0.0\n");

    await expect(isExternalCliAvailable("copilot")).resolves.toBe(true);
    expect(execFileMock).toHaveBeenCalledWith(
      "gh",
      ["--version"],
      expect.objectContaining({ timeout: 5_000 }),
      expect.any(Function),
    );
  });

  test("reports false when the CLI probe fails", async () => {
    // A missing or broken `gh` binary must degrade to "not available" instead
    // of surfacing the spawn error, so the caller can fall back to a manual
    // credential prompt.
    execFileRejects();

    await expect(isExternalCliAvailable("copilot")).resolves.toBe(false);
  });

  test("reports false for a provider that has no external CLI adapter", async () => {
    // `anthropic` authenticates by API key, so there is no adapter to probe and
    // the CLI must never be spawned.
    await expect(isExternalCliAvailable("anthropic")).resolves.toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe("detectExternalCliCredential", () => {
  test("returns null for a provider without an external CLI adapter", async () => {
    await expect(detectExternalCliCredential("anthropic")).resolves.toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test("returns null when the token command fails", async () => {
    // No active `gh` session means `gh auth token` exits non-zero; the failure
    // is swallowed so detection reports "no credential" rather than throwing.
    execFileRejects();

    await expect(detectExternalCliCredential("copilot")).resolves.toBeNull();
  });

  test("returns null when the token command emits only whitespace", async () => {
    execFileResolves("   \n");

    await expect(detectExternalCliCredential("copilot")).resolves.toBeNull();
  });
});

describe("resolveExternalCliCredential", () => {
  test("returns false for a provider that does not use external CLI auth", async () => {
    // `anthropic` is API-key authenticated, so the external-CLI path is a
    // no-op and must not shell out or mutate the environment.
    const env: NodeJS.ProcessEnv = {};

    await expect(resolveExternalCliCredential("anthropic", env)).resolves.toBe(
      false,
    );
    expect(execFileMock).not.toHaveBeenCalled();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("returns false when no credential can be detected", async () => {
    // An empty `gh auth token` result leaves the env untouched so a later step
    // can prompt for an interactive login instead of exporting a blank key.
    execFileResolves("\n");
    const env: NodeJS.ProcessEnv = {};

    await expect(resolveExternalCliCredential("copilot", env)).resolves.toBe(
      false,
    );
    expect(env.COPILOT_API_KEY).toBeUndefined();
  });
});

describe("runExternalCliLogin", () => {
  /**
   * Returns a fake child process whose `error`/`exit` events can be emitted by
   * the test, standing in for the interactive `gh auth login` subprocess so no
   * real login is spawned.
   */
  function fakeChild(): EventEmitter {
    const child = new EventEmitter();
    spawnMock.mockReturnValue(child);
    return child;
  }

  test("resolves true when the login subprocess exits cleanly", async () => {
    const child = fakeChild();

    const pending = runExternalCliLogin("copilot");
    child.emit("exit", 0);

    await expect(pending).resolves.toBe(true);
    expect(spawnMock).toHaveBeenCalledWith(
      "gh",
      ["auth", "login", "--hostname", "github.com"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  test("resolves false when the login subprocess exits non-zero", async () => {
    const child = fakeChild();

    const pending = runExternalCliLogin("copilot");
    child.emit("exit", 1);

    await expect(pending).resolves.toBe(false);
  });

  test("resolves false when the login subprocess cannot be spawned", async () => {
    // A missing `gh` binary surfaces as an `error` event; the login reports
    // failure rather than rejecting so the caller can guide the user to install
    // the CLI.
    const child = fakeChild();

    const pending = runExternalCliLogin("copilot");
    child.emit("error", new Error("ENOENT"));

    await expect(pending).resolves.toBe(false);
  });

  test("resolves false without spawning for a provider with no adapter", async () => {
    await expect(runExternalCliLogin("anthropic")).resolves.toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
