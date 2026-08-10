import type { MutableRefObject } from "react";
import { describe, expect, test } from "vitest";
import type { CredentialDiagnostic } from "../../../src/config/env.ts";
import {
  updateRunningCredentialDiagnostics,
  type RunState,
} from "../../../src/cli/app/run-state.ts";

/**
 * A minimal, non-secret credential diagnostic. `preview`/`length` are the only
 * value-adjacent fields and are deliberately masked/coarse, mirroring how the
 * real diagnostics are produced.
 */
const DIAGNOSTICS: CredentialDiagnostic[] = [
  {
    key: "ANTHROPIC_API_KEY",
    source: "~/.openwiki/.env",
    length: 40,
    preview: "sk-…xxxx",
    warnings: [],
  },
];

/**
 * A live-run state. The `command` payload is irrelevant to the transition (the
 * function only branches on `status` and spreads the rest), so it is cast in.
 */
const RUNNING: RunState = {
  status: "running",
  command: { kind: "run" },
  log: [],
} as unknown as RunState;

/**
 * A fresh ref for each call, standing in for the App's
 * `credentialDiagnosticsRef` so we can assert the function records the
 * diagnostics for a later settle to carry forward.
 */
function makeRef(): MutableRefObject<CredentialDiagnostic[] | undefined> {
  return { current: undefined };
}

describe("updateRunningCredentialDiagnostics", () => {
  test("folds diagnostics into a live run and records them on the ref", () => {
    const ref = makeRef();

    const next = updateRunningCredentialDiagnostics(RUNNING, DIAGNOSTICS, ref);

    expect(next.status).toBe("running");
    expect(
      (next as Extract<RunState, { status: "running" }>).credentialDiagnostics,
    ).toEqual(DIAGNOSTICS);
    expect(ref.current).toEqual(DIAGNOSTICS);
    // A new object is returned; the input state is not mutated.
    expect(next).not.toBe(RUNNING);
  });

  test("is a no-op on a settled run but still records them on the ref", () => {
    const ref = makeRef();
    const state: RunState = { status: "idle" };

    const next = updateRunningCredentialDiagnostics(state, DIAGNOSTICS, ref);

    // The state passes through unchanged so a late resolution cannot resurrect
    // a settled run, but the ref still captures the diagnostics.
    expect(next).toBe(state);
    expect(ref.current).toEqual(DIAGNOSTICS);
  });

  test("does not fold diagnostics into an error state", () => {
    const ref = makeRef();
    const state: RunState = { status: "error", message: "boom" };

    const next = updateRunningCredentialDiagnostics(state, DIAGNOSTICS, ref);

    expect(next).toBe(state);
    expect(
      (next as Extract<RunState, { status: "error" }>).credentialDiagnostics,
    ).toBeUndefined();
    expect(ref.current).toEqual(DIAGNOSTICS);
  });
});
