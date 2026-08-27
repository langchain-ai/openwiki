import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { createEmptyOnboardingConfig } from "../../src/setup/onboarding.ts";
import type { OpenWikiOnboardingConfig } from "../../src/setup/onboarding.ts";

// This file exclusively drives the macOS native surface of schedules.ts: the
// launchctl / osascript(pmset) shell-outs and the plist/argv builders that are
// only reachable through them. The child_process and os mocks are deliberately
// kept in their own file so they never leak into the pure-surface suites.

// A private HOME so every plist/log write lands under a throwaway tree instead
// of the developer's real ~/Library/LaunchAgents and ~/.openwiki. It is a plain
// path string (not yet created) because openwiki-home.ts computes its module
// constant from os.homedir() at import time; the directories are materialized
// lazily by the code under test and removed in afterAll.
const HOME = vi.hoisted(() => {
  const base = (process.env.TMPDIR ?? "/tmp").replace(/\/$/u, "");
  return `${base}/openwiki-launchd-home-${process.pid}-${Date.now()}`;
});

// schedules.ts and openwiki-home.ts both resolve install locations from
// os.homedir(); redirect only that function and pass everything else through so
// os.userInfo()/os.tmpdir() keep working.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const patched = { ...actual, homedir: () => HOME };
  return { ...patched, default: patched };
});

// promisify(execFile) inside schedules.ts turns this plain mock into a
// promise-returning shim: it invokes the mock with (command, argv, callback)
// and resolves/rejects from the callback, so the fake never spawns a real
// launchctl/osascript process.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import {
  deleteConnectorSchedules,
  installConnectorSchedule,
  installOpenWikiPowerSchedule,
  listConnectorSchedules,
  resumeConnectorSchedules,
} from "../../src/scheduling/schedules.ts";

const LABEL = "com.openwiki.ingestion";
const LAUNCH_AGENTS_DIR = path.join(HOME, "Library", "LaunchAgents");
const PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, `${LABEL}.plist`);
// Mirrors getLaunchdDomain(): the current uid on any POSIX host, matching the
// value the code derives from process.getuid().
const LAUNCHD_DOMAIN = `gui/${process.getuid?.() ?? os.userInfo().uid}`;

const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_CONFIG_DIR = process.env.OPENWIKI_CONFIG_DIR;

/**
 * Outcome the execFile stub should produce for a given invocation. Returning an
 * error drives the callback's failure branch (a non-zero exit or a spawn
 * error, which are indistinguishable to promisify(execFile)); returning nothing
 * resolves as a clean, zero-exit run.
 */
type ExecOutcome = { error?: Error };

/**
 * Per-test router for the execFile stub, keyed off the command and its argv so
 * a test can fail one specific shell-out (e.g. `launchctl print`) while letting
 * the rest succeed. Reset to all-success before each test.
 */
let execFileOutcome: (command: string, args: string[]) => ExecOutcome;

/**
 * Forces the module's `process.platform` reads down the darwin branch
 * regardless of the host CI runner, so the native install/uninstall paths are
 * exercised everywhere. Restored in afterEach.
 */
function stubDarwin(): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: "darwin",
  });
}

beforeEach(async () => {
  stubDarwin();
  execFileOutcome = () => ({});
  execFileMock.mockImplementation((...callArgs: unknown[]) => {
    const done = callArgs.at(-1) as (
      error: Error | null,
      stdout: unknown,
      stderr: string,
    ) => void;
    const command = callArgs[0] as string;
    const args = (callArgs[1] as string[]) ?? [];
    const { error } = execFileOutcome(command, args);
    // Mirror execFile's { stdout, stderr } custom-promisify shape; the code only
    // cares about resolve vs reject, not the payload.
    done(error ?? null, { stdout: "", stderr: "" }, "");
  });

  // Each test starts from a clean plist slot so a prior install's file can't
  // mask a later "already removed" assertion; force ignores a missing path.
  await rm(PLIST_PATH, { force: true, recursive: true });
});

afterEach(() => {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: ORIGINAL_PLATFORM,
  });
  execFileMock.mockReset();
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.OPENWIKI_CONFIG_DIR;
  else process.env.OPENWIKI_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
});

afterAll(async () => {
  await rm(HOME, { force: true, recursive: true });
});

/** Builds an onboarding config carrying a single ingestion schedule. */
function configWithSchedule(
  expression: string,
  overrides: Partial<
    NonNullable<OpenWikiOnboardingConfig["ingestionSchedule"]>
  > = {},
): OpenWikiOnboardingConfig {
  return {
    ...createEmptyOnboardingConfig(),
    ingestionSchedule: {
      description: "All ingestion",
      expression,
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    },
  };
}

/**
 * Adds an enabled pmset repeat schedule so power reconciliation has saved state
 * to act on (install-or-cancel), reaching the darwin osascript paths.
 */
function withEnabledPmset(
  config: OpenWikiOnboardingConfig,
): OpenWikiOnboardingConfig {
  return {
    ...config,
    powerManagement: {
      pmset: {
        days: "MTWRFSU",
        enabled: true,
        sleepTime: "02:30:00",
        updatedAt: "2026-01-01T00:00:00.000Z",
        wakeTime: "01:58:00",
      },
    },
  };
}

/** All recorded execFile invocations as [command, argv, ...] tuples. */
function execFileCalls(): unknown[][] {
  return execFileMock.mock.calls;
}

/** First recorded invocation of `command` whose first argv entry is `sub`. */
function findCall(command: string, sub: string): unknown[] | undefined {
  return execFileCalls().find(
    (call) =>
      call[0] === command &&
      Array.isArray(call[1]) &&
      (call[1] as string[])[0] === sub,
  );
}

/**
 * Asserts a recorded execFile invocation shells out safely: the binary and its
 * arguments are passed as a (command, argv[]) pair rather than one concatenated
 * shell string, and no `{ shell: true }` option is present. execFile never
 * routes through /bin/sh unless shell:true is set, so this shape is what
 * prevents operator- or config-influenced values from being reinterpreted as
 * shell syntax (argv-injection safety).
 */
function expectSafeArgv(call: unknown[], command: string): void {
  expect(call[0]).toBe(command);
  expect(Array.isArray(call[1])).toBe(true);
  // promisify(execFile) appends only a Node-style callback, so the final arg is
  // a function and there is no options object carrying shell:true.
  expect(call.at(-1)).toBeTypeOf("function");
  const options = call
    .slice(2, -1)
    .find(
      (arg): arg is Record<string, unknown> =>
        typeof arg === "object" && arg !== null && !Array.isArray(arg),
    );
  expect(options?.shell ?? false).toBe(false);
}

describe("installConnectorSchedule (darwin native install)", () => {
  test("writes an escaped plist and bootstraps it with an explicit argv", async () => {
    // A working directory laden with every XML-significant character proves the
    // plist builder escapes each one; an unescaped value would corrupt the
    // property list (or allow injecting extra keys).
    const cwd = `/repo & <danger> "q" 'a'`;

    const result = await installConnectorSchedule({
      connectorId: "git-repo",
      cronExpression: "0 2 * * *",
      cwd,
    });

    expect(result.launchAgentPath).toBe(PLIST_PATH);
    expect(result.warning).toBeUndefined();

    const plist = await readFile(PLIST_PATH, "utf8");
    // escapePlist must map & < > " ' to their entities in the WorkingDirectory.
    expect(plist).toContain(
      `<string>/repo &amp; &lt;danger&gt; &quot;q&quot; &apos;a&apos;</string>`,
    );
    expect(plist).not.toContain(`<danger>`);
    expect(plist).toContain(`<string>${LABEL}</string>`);
    // "0 2 * * *" -> launchd StartCalendarInterval Minute 0, Hour 2.
    expect(plist).toContain("<key>Minute</key>\n    <integer>0</integer>");
    expect(plist).toContain("<key>Hour</key>\n    <integer>2</integer>");
    expect(plist).not.toContain("<key>OPENWIKI_CONFIG_DIR</key>");

    // Pre-existing agents are booted out before the new one is bootstrapped.
    const bootout = findCall("launchctl", "bootout");
    const bootstrap = findCall("launchctl", "bootstrap");
    expect(bootout?.[1]).toEqual(["bootout", `${LAUNCHD_DOMAIN}/${LABEL}`]);
    expect(bootstrap?.[1]).toEqual(["bootstrap", LAUNCHD_DOMAIN, PLIST_PATH]);
    expectSafeArgv(bootstrap as unknown[], "launchctl");
  });

  test("persists the resolved config directory for scheduled runs", async () => {
    const configuredDir = path.join(HOME, "state & <configured>");
    process.env.OPENWIKI_CONFIG_DIR = configuredDir;

    await installConnectorSchedule({
      connectorId: "git-repo",
      cronExpression: "0 2 * * *",
      cwd: "/repo",
    });

    const plist = await readFile(PLIST_PATH, "utf8");
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<key>OPENWIKI_CONFIG_DIR</key>");
    expect(plist).toContain(
      `<string>${configuredDir.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</string>`,
    );
  });

  test("propagates a launchctl bootstrap failure", async () => {
    // bootout is best-effort (swallowed); a bootstrap failure is real and must
    // surface so the caller does not report a phantom install.
    execFileOutcome = (command, args) =>
      command === "launchctl" && args[0] === "bootstrap"
        ? { error: new Error("Bootstrap failed: 5: Input/output error") }
        : {};

    await expect(
      installConnectorSchedule({
        connectorId: "git-repo",
        cronExpression: "0 2 * * *",
        cwd: "/repo",
      }),
    ).rejects.toThrow(/Bootstrap failed/u);
  });
});

describe("installOpenWikiPowerSchedule (darwin pmset via osascript)", () => {
  test("installs the repeat wake window with single-quoted pmset argv under admin privileges", async () => {
    const result = await installOpenWikiPowerSchedule(
      configWithSchedule("0 2 * * *"),
    );

    expect(result.enabled).toBe(true);
    expect(result.warning).toMatch(/one repeat power schedule/iu);

    const call = findCall("osascript", "-e");
    expect(call).toBeDefined();
    expectSafeArgv(call as unknown[], "osascript");

    const script = (call?.[1] as string[])[1];
    expect(script).toContain("do shell script ");
    expect(script).toContain("with administrator privileges");
    // Every pmset token is individually single-quoted, so an
    // operator-configured day/time value cannot break out of its argument and
    // inject additional shell words.
    expect(script).toContain(
      `'pmset' 'repeat' 'wakeorpoweron' 'MTWRFSU' '01:58:00' 'sleep' 'MTWRFSU' '02:30:00'`,
    );
  });

  test("reports a warning instead of throwing when osascript fails", async () => {
    // A cancelled admin prompt or a pmset error exits non-zero; the failure is
    // captured into a user-facing warning rather than propagated.
    execFileOutcome = () => ({ error: new Error("User cancelled.") });

    const result = await installOpenWikiPowerSchedule(
      configWithSchedule("0 2 * * *"),
    );

    expect(result.enabled).toBe(false);
    expect(result.warning).toBe(
      "Wake setup was not installed: User cancelled.",
    );
  });
});

describe("isLaunchAgentLoaded via listConnectorSchedules (darwin)", () => {
  test("reports the agent as loaded when launchctl print succeeds", async () => {
    const [status] = await listConnectorSchedules(
      configWithSchedule("0 2 * * *"),
    );

    expect(status.launchAgentLoaded).toBe(true);
    const call = findCall("launchctl", "print");
    expect(call?.[1]).toEqual(["print", `${LAUNCHD_DOMAIN}/${LABEL}`]);
    expectSafeArgv(call as unknown[], "launchctl");
  });

  test("reports the agent as not loaded when launchctl print fails", async () => {
    // `launchctl print` exits non-zero for an unknown label; that is the normal
    // "not installed" signal and must read as unloaded, not as an error.
    execFileOutcome = () => ({ error: new Error("Could not find service") });

    const [status] = await listConnectorSchedules(
      configWithSchedule("0 2 * * *"),
    );

    expect(status.launchAgentLoaded).toBe(false);
  });
});

describe("deleteConnectorSchedules (darwin cleanup)", () => {
  test("unloads the agent, removes the plist, and cancels the pmset schedule", async () => {
    const result = await deleteConnectorSchedules(
      withEnabledPmset(configWithSchedule("0 2 * * *")),
      "all",
    );

    expect(result.config.ingestionSchedule).toBeUndefined();
    // No ingestion schedule remains, so reconciliation cancels the saved,
    // enabled pmset window.
    expect(result.powerSchedule?.enabled).toBe(false);
    expect(result.config.powerManagement?.pmset?.enabled).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);

    expect(findCall("launchctl", "bootout")?.[1]).toEqual([
      "bootout",
      `${LAUNCHD_DOMAIN}/${LABEL}`,
    ]);
    const cancel = findCall("osascript", "-e");
    expect(cancel).toBeDefined();
    expectSafeArgv(cancel as unknown[], "osascript");
    expect((cancel?.[1] as string[])[1]).toContain(`'pmset' 'repeat' 'cancel'`);
  });

  test("swallows a bootout failure yet still reports a pmset cancel failure", async () => {
    // `launchctl bootout` failing (agent already gone) is expected and must be
    // swallowed so deletion proceeds; a failing pmset cancel, by contrast, is
    // captured into a warning rather than dropped.
    execFileOutcome = (command) =>
      command === "launchctl"
        ? { error: new Error("Boot-out failed: 3: No such process") }
        : { error: new Error("cancel denied") };

    const result = await deleteConnectorSchedules(
      withEnabledPmset(configWithSchedule("0 2 * * *")),
      "all",
    );

    expect(result.config.ingestionSchedule).toBeUndefined();
    expect(result.powerSchedule?.enabled).toBe(false);
    expect(result.warnings).toContain(
      "Wake setup was not removed: cancel denied",
    );
  });

  test("rethrows a non-ENOENT failure while removing the plist", async () => {
    // Make the plist path a directory so unlink() fails with EPERM/EISDIR rather
    // than ENOENT; that is a real filesystem fault the code must surface instead
    // of silently swallowing like the missing-file case.
    await mkdir(PLIST_PATH, { recursive: true });

    await expect(
      deleteConnectorSchedules(configWithSchedule("0 2 * * *"), "all"),
    ).rejects.toThrow();
  });
});

describe("resumeConnectorSchedules (darwin reinstall + power reconcile)", () => {
  test("reinstalls the launch agent and updates the pmset wake window", async () => {
    const result = await resumeConnectorSchedules({
      config: withEnabledPmset(
        configWithSchedule("0 2 * * *", {
          pausedAt: "2026-01-02T00:00:00.000Z",
        }),
      ),
      cwd: "/repo",
      target: "all",
    });

    expect(result.connectorIds).toEqual(["all"]);
    expect(result.config.ingestionSchedule?.pausedAt).toBeUndefined();
    expect(result.config.ingestionSchedule?.launchAgentPath).toBe(PLIST_PATH);
    // An active ingestion schedule plus saved pmset drives reconciliation down
    // the install-power-window branch, re-enabling the wake schedule.
    expect(result.powerSchedule?.enabled).toBe(true);

    expect(findCall("launchctl", "bootstrap")?.[1]).toEqual([
      "bootstrap",
      LAUNCHD_DOMAIN,
      PLIST_PATH,
    ]);
    expect(findCall("osascript", "-e")).toBeDefined();
  });
});
