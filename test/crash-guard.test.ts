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
// fingerprinted (agent_error + error_name) on the way through the guard.
const recordRunSafe = vi.fn(() => Promise.resolve(undefined));
const persistRunMetadataIfChanged = vi.fn(() => Promise.resolve(true));

vi.mock("../src/telemetry/record-run-safe.ts", () => ({
  recordRunSafe: (...args: unknown[]) => recordRunSafe(...args),
}));
vi.mock("../src/agent/utils.ts", () => ({
  persistRunMetadataIfChanged: (...args: unknown[]) =>
    persistRunMetadataIfChanged(...args),
}));

import {
  clearActiveRun,
  getActiveRun,
  handleFatal,
  registerActiveRun,
  type ActiveRunRecord,
} from "../src/agent/crash-guard.ts";

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
    // its constructor name as the fingerprint.
    expect(facts).toMatchObject({
      outcome: "failure",
      errorClass: "agent_error",
      errorName: "TypeError",
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
});
