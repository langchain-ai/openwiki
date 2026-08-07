import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from "vitest";

// The crash guard's two side effects are mocked so the post-mortem can be asserted
// without a real telemetry send or a metadata write. describeErrorForTelemetry is
// left REAL, so these tests also prove a residual crash is classified and
// fingerprinted (agent_error + its error_detail name) on the way through the guard.
const recordRunSafe = vi.fn(() => Promise.resolve(undefined));
const persistRunMetadataIfChanged = vi.fn(() => Promise.resolve(true));

vi.mock("../../src/telemetry/record-run-safe.ts", () => ({
  recordRunSafe: (...args: unknown[]) => recordRunSafe(...args),
}));
vi.mock("../../src/agent/utils.ts", () => ({
  persistRunMetadataIfChanged: (...args: unknown[]) =>
    persistRunMetadataIfChanged(...args),
}));

import {
  clearActiveRun,
  getActiveRun,
  handleFatal,
  installCrashGuard,
  registerActiveRun,
  type ActiveRunRecord,
} from "../../src/agent/crash-guard.ts";

const ACTIVE: ActiveRunRecord = {
  command: "init",
  cwd: "/repo",
  modelId: "some-model",
  outputMode: "repository",
  snapshotBefore: "snapshot-hash",
  language: "en",
};

/**
 * Awaits handleFatal, then flushes the one setImmediate it schedules for the exit,
 * so process.exit can be asserted synchronously afterward.
 */
async function runFatal(source: string, error: unknown): Promise<void> {
  await handleFatal(source, error);
  await new Promise((resolve) => setImmediate(resolve));
}

let exitSpy: MockInstance;
let stderrSpy: MockInstance;

beforeEach(() => {
  recordRunSafe.mockClear();
  persistRunMetadataIfChanged.mockClear();
  // Neutralize the two process-level effects so a test never actually exits or
  // spams the reporter.
  exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation(() => undefined as never);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  clearActiveRun();
  exitSpy.mockRestore();
  stderrSpy.mockRestore();
});

describe("active-run registry", () => {
  test("round-trips a registration and clears it", () => {
    expect(getActiveRun()).toBeUndefined();

    registerActiveRun(ACTIVE);
    expect(getActiveRun()).toEqual(ACTIVE);

    clearActiveRun();
    expect(getActiveRun()).toBeUndefined();
  });
});

describe("handleFatal", () => {
  test("records the crash as a classified, fingerprinted failure", async () => {
    registerActiveRun(ACTIVE);

    await runFatal("unhandledRejection", new TypeError("boom"));

    expect(recordRunSafe).toHaveBeenCalledTimes(1);
    const [command, options, facts] = recordRunSafe.mock.calls[0] as [
      string,
      { outputMode: string },
      Record<string, unknown>,
    ];
    expect(command).toBe("init");
    expect(options).toEqual({ outputMode: "repository" });
    // The real describeErrorForTelemetry ran: a residual crash is agent_error with
    // the thrown error's name as its error_detail fingerprint.
    expect(facts).toMatchObject({
      outcome: "failure",
      errorClass: "agent_error",
      errorDetail: "TypeError",
    });
  });

  test("stamps the interrupted run so the next update retries", async () => {
    registerActiveRun(ACTIVE);

    await runFatal("uncaughtException", new Error("boom"));

    expect(persistRunMetadataIfChanged).toHaveBeenCalledWith(
      "init",
      "/repo",
      "some-model",
      "repository",
      "snapshot-hash",
      "interrupted",
      "en",
    );
  });

  test("stamps a null snapshot when the crash preceded any snapshot", async () => {
    // A run can crash before its before-snapshot is captured; the stamp then records
    // null rather than a hash, so the interrupted marker is still written.
    registerActiveRun({ ...ACTIVE, snapshotBefore: undefined });

    await runFatal("uncaughtException", new Error("boom"));

    expect(persistRunMetadataIfChanged).toHaveBeenCalledWith(
      "init",
      "/repo",
      "some-model",
      "repository",
      null,
      "interrupted",
      "en",
    );
  });

  test("clears the active run and exits non-zero", async () => {
    registerActiveRun(ACTIVE);

    await runFatal("unhandledRejection", new Error("boom"));

    expect(getActiveRun()).toBeUndefined();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("a failing recorder does not skip the stamp or the exit", async () => {
    registerActiveRun(ACTIVE);
    recordRunSafe.mockRejectedValueOnce(new Error("telemetry down"));

    await runFatal("unhandledRejection", new Error("boom"));

    // Each side effect is independently guarded: the recorder throwing must not
    // prevent the interrupted stamp or the exit.
    expect(persistRunMetadataIfChanged).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("a failing stamp does not prevent the exit", async () => {
    registerActiveRun(ACTIVE);
    persistRunMetadataIfChanged.mockRejectedValueOnce(new Error("disk full"));

    await runFatal("unhandledRejection", new Error("boom"));

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("with no active run it still exits but records nothing", async () => {
    // A crash before any run registered (or after it cleared): there is nothing to
    // attribute, but the process must still exit rather than limp on.
    await runFatal("uncaughtException", new Error("early boom"));

    expect(recordRunSafe).not.toHaveBeenCalled();
    expect(persistRunMetadataIfChanged).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("writes exactly one stderr line for the local failure UX", async () => {
    registerActiveRun(ACTIVE);

    await runFatal("unhandledRejection", new Error("visible message"));

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const line = stderrSpy.mock.calls[0]?.[0] as string;
    expect(line).toContain("unhandledRejection");
    expect(line).toContain("visible message");
  });

  test("a burst of concurrent fatal signals records the crash exactly once", async () => {
    registerActiveRun(ACTIVE);

    // The installer fires `void handleFatal(...)` fire-and-forget, once per escaped
    // rejection, so a burst arrives with no await between calls and every handler runs
    // its synchronous prefix back-to-back. The first must claim the run; every later
    // one must see it already cleared. Before the sync-claim fix each of the 50 read
    // the still-set run and recorded it, which is the one-crash-261-events bug.
    await Promise.all(
      Array.from({ length: 50 }, (_unused, index) =>
        handleFatal("unhandledRejection", new Error(`boom ${index}`)),
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(recordRunSafe).toHaveBeenCalledTimes(1);
    expect(persistRunMetadataIfChanged).toHaveBeenCalledTimes(1);
    expect(getActiveRun()).toBeUndefined();
  });

  test("handles a non-Error thrown value by stringifying it for the stderr line", async () => {
    registerActiveRun(ACTIVE);

    // A rejection can carry any value, not just an Error. The guard must still
    // record, stamp, and exit, and its stderr line stringifies the raw value
    // instead of reading a .message/.stack that isn't there.
    await runFatal("unhandledRejection", "bare string failure");

    expect(recordRunSafe).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const line = stderrSpy.mock.calls[0]?.[0] as string;
    expect(line).toContain("bare string failure");
  });

  test("prints the error stack as a second stderr line under OPENWIKI_DEBUG", async () => {
    registerActiveRun(ACTIVE);
    const previous = process.env.OPENWIKI_DEBUG;
    process.env.OPENWIKI_DEBUG = "1";

    try {
      await runFatal("uncaughtException", new Error("boom with stack"));

      // Debug mode adds a second write: the failure UX line, then the raw stack.
      expect(stderrSpy).toHaveBeenCalledTimes(2);
      const stackLine = stderrSpy.mock.calls[1]?.[0] as string;
      expect(stackLine).toContain("boom with stack");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENWIKI_DEBUG;
      } else {
        process.env.OPENWIKI_DEBUG = previous;
      }
    }
  });

  test("skips the stack line under OPENWIKI_DEBUG when the error carries no stack", async () => {
    registerActiveRun(ACTIVE);
    const previous = process.env.OPENWIKI_DEBUG;
    process.env.OPENWIKI_DEBUG = "1";
    const stackless = new Error("no stack here");
    delete stackless.stack;

    try {
      await runFatal("uncaughtException", stackless);

      // Debug mode only appends the stack line when there is a stack to print, so a
      // stackless error still yields exactly the one failure-UX line.
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENWIKI_DEBUG;
      } else {
        process.env.OPENWIKI_DEBUG = previous;
      }
    }
  });
});

describe("installCrashGuard", () => {
  test("registers both fatal handlers once, idempotently, wired to handleFatal", async () => {
    // Capture the listeners instead of attaching them to the real process, so the
    // test never installs live handlers that outlive it.
    const handlers = new Map<string, (arg: unknown) => void>();
    const onSpy = vi.spyOn(process, "on").mockImplementation(((
      event: string,
      listener: (arg: unknown) => void,
    ) => {
      handlers.set(event, listener);
      return process;
    }) as typeof process.on);

    try {
      installCrashGuard();
      const callsAfterFirst = onSpy.mock.calls.length;
      expect(handlers.has("unhandledRejection")).toBe(true);
      expect(handlers.has("uncaughtException")).toBe(true);

      // Idempotent singleton: a repeat call registers no further handlers.
      installCrashGuard();
      expect(onSpy.mock.calls.length).toBe(callsAfterFirst);

      // The registered handler routes an escaped rejection through handleFatal, so
      // with an active run it records and stamps the crash and still exits.
      registerActiveRun(ACTIVE);
      handlers.get("unhandledRejection")?.(new Error("escaped"));
      // The handler is fire-and-forget (`void handleFatal`): its two awaits run on
      // the microtask queue and only then schedule the exit on setImmediate, so two
      // macrotask flushes are needed to reach past the recorder to the exit.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(recordRunSafe).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);

      // The uncaughtException listener is wired the same way: with a fresh active
      // run it routes through handleFatal, records the crash, and exits.
      registerActiveRun(ACTIVE);
      handlers.get("uncaughtException")?.(new Error("thrown"));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(recordRunSafe).toHaveBeenCalledTimes(2);
      expect(exitSpy).toHaveBeenCalledTimes(2);
    } finally {
      onSpy.mockRestore();
    }
  });
});
