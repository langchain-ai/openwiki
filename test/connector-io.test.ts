import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type ConnectorIo = typeof import("../src/connectors/io.ts");

let tempHome: string;
let io: ConnectorIo;

beforeEach(async () => {
  tempHome = await mkdtemp(path.join(tmpdir(), "openwiki-connector-io-"));
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof import("node:os")>("node:os");
    return {
      ...actual,
      homedir: () => tempHome,
      default: {
        ...(actual.default as typeof import("node:os")),
        homedir: () => tempHome,
      },
    };
  });
  io = await import("../src/connectors/io.ts");
});

afterEach(async () => {
  vi.doUnmock("node:os");
  vi.resetModules();
  await rm(tempHome, { recursive: true, force: true });
});

describe("connector run identity", () => {
  test("adds a collision-resistant suffix to timestamp IDs", () => {
    const first = io.createRunId();
    const second = io.createRunId();

    expect(first).not.toBe(second);
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2}T.*-[0-9a-f-]{36}$/u);
  });
});

describe("updateConnectorState", () => {
  test("serializes concurrent read-transform-write transactions", async () => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let updaterCalls = 0;

    const first = io.updateConnectorState("notion", async (state) => {
      updaterCalls += 1;
      firstStarted();
      await firstReleased;
      return io.updateStateWithRun(state, {
        at: "first",
        rawFiles: ["first.json"],
        runId: "first",
        status: "success",
        warnings: [],
      });
    });
    await firstReady;

    const second = io.updateConnectorState("notion", (state) => {
      updaterCalls += 1;
      return io.updateStateWithRun(state, {
        at: "second",
        rawFiles: ["second.json"],
        runId: "second",
        status: "success",
        warnings: [],
      });
    });
    await Promise.resolve();
    expect(updaterCalls).toBe(1);

    releaseFirst();
    await Promise.all([first, second]);

    const state = JSON.parse(
      await readFile(
        path.join(tempHome, ".openwiki/connectors/notion/state.json"),
        "utf8",
      ),
    ) as { runs: Array<{ runId: string }> };
    expect(state.runs.map((run) => run.runId)).toEqual(["second", "first"]);
  });
});
