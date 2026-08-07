import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from "vitest";
import {
  writePrintAuthFix,
  writePrintErrorDiagnostics,
} from "../../src/cli/runners.ts";

/**
 * A fake Anthropic key. It is planted in both `process.env` (so the diagnostic
 * sanitizer knows to redact it) and inside an error message, to prove the raw
 * value never reaches stderr.
 */
const FAKE_SECRET = "sk-ant-FAKE-secret-value-000111222";

let stderrSpy: MockInstance<typeof process.stderr.write>;
let written: string[];

const savedEnv = { ...process.env };

beforeEach(() => {
  written = [];
  stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      written.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
});

afterEach(() => {
  stderrSpy.mockRestore();
  // Restore any env keys the tests set (provider selection, planted secret).
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
});

describe("writePrintErrorDiagnostics", () => {
  test("prints allowlisted labels and redacts a planted secret", () => {
    // The name/message fields are only surfaced in debug mode.
    process.env.OPENWIKI_DEBUG = "1";
    process.env.ANTHROPIC_API_KEY = FAKE_SECRET;

    const error = new Error(`request failed using key ${FAKE_SECRET}`);
    writePrintErrorDiagnostics(error);

    const output = written.join("");

    // Allowlisted, human-readable fields are shown...
    expect(output).toContain("Error Diagnostics");
    expect(output).toContain("name: Error");
    expect(output).toContain("message:");
    // ...but the raw secret is masked, never printed.
    expect(output).not.toContain(FAKE_SECRET);
    expect(output).toContain("[REDACTED:ANTHROPIC_API_KEY]");
  });

  test("writes nothing when there are no diagnostics", () => {
    writePrintErrorDiagnostics(undefined);
    expect(written.join("")).toBe("");
  });
});

describe("writePrintAuthFix", () => {
  test("prints how-to-fix guidance for an auth error without leaking secrets", () => {
    process.env.OPENWIKI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = FAKE_SECRET;

    // A 401 marks this as an auth failure, so a fix panel is emitted.
    writePrintAuthFix({ status: 401 }, "unauthorized");

    const output = written.join("");

    expect(output).toContain("How to fix");
    expect(output).toContain("For full detail, re-run with --debug.");
    // Guidance references files and commands, never the secret value itself.
    expect(output).not.toContain(FAKE_SECRET);
  });

  test("writes nothing when the error is not an auth error", () => {
    writePrintAuthFix(new Error("disk full"), "disk full");
    expect(written.join("")).toBe("");
  });
});
