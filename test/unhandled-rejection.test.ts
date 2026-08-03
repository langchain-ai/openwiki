import { afterEach, describe, expect, test, vi } from "vitest";
import {
  handleUnhandledRejection,
  installUnhandledRejectionHandler,
} from "../src/unhandled-rejection.ts";

/**
 * A provider rate-limit rejection shaped like the one LangChain surfaces when
 * the model provider returns 429 (see #494): an Error whose message carries
 * the status line and troubleshooting URL, plus a numeric `status` field.
 */
function createRateLimitError(): Error & { status: number } {
  return Object.assign(
    new Error(
      "429 The usage limit has been reached\n\nTroubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/MODEL_RATE_LIMIT/",
    ),
    { status: 429 },
  );
}

function mockStderrAndExit() {
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  const exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation(() => undefined as never);

  return {
    written: (): string =>
      stderrSpy.mock.calls.map((call) => String(call[0])).join(""),
    exitSpy,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleUnhandledRejection", () => {
  test("prints the clean provider message and exits non-zero on a 429 rejection", () => {
    const { written, exitSpy } = mockStderrAndExit();

    handleUnhandledRejection(createRateLimitError());

    const output = written();
    expect(output).toContain("429 The usage limit has been reached");
    expect(output).toContain("Troubleshooting URL:");
    // A clean message, not the raw stack trace an unhandled rejection prints.
    expect(output).not.toMatch(/^\s+at /mu);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("redacts secrets through the shared diagnostics path", () => {
    const { written, exitSpy } = mockStderrAndExit();

    handleUnhandledRejection(
      new Error("429 rate limited for Bearer sk-live-secret-token"),
    );

    const output = written();
    expect(output).not.toContain("sk-live-secret-token");
    expect(output).toContain("Bearer [REDACTED]");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("falls back to a generic message for non-Error rejection reasons", () => {
    const { written, exitSpy } = mockStderrAndExit();

    handleUnhandledRejection("boom");

    expect(written()).toContain("OpenWiki agent run failed.");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("installUnhandledRejectionHandler", () => {
  test("registers the handler on process", () => {
    const before = process.rawListeners("unhandledRejection");

    installUnhandledRejectionHandler();

    try {
      expect(process.rawListeners("unhandledRejection")).toContain(
        handleUnhandledRejection,
      );
    } finally {
      process.off("unhandledRejection", handleUnhandledRejection);
    }

    expect(process.rawListeners("unhandledRejection")).toEqual(before);
  });

  test("an escaped provider 429 is dispatched to the handler instead of crashing raw", () => {
    const { written, exitSpy } = mockStderrAndExit();

    // Vitest keeps its own unhandledRejection listeners to fail the run on
    // stray rejections; detach them while simulating the escaped rejection so
    // only the CLI's net observes it, then restore them.
    const vitestListeners = process.rawListeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    installUnhandledRejectionHandler();

    try {
      process.emit(
        "unhandledRejection",
        createRateLimitError(),
        Promise.resolve(),
      );
    } finally {
      process.removeAllListeners("unhandledRejection");

      for (const listener of vitestListeners) {
        process.on(
          "unhandledRejection",
          listener as NodeJS.UnhandledRejectionListener,
        );
      }
    }

    expect(written()).toContain("429 The usage limit has been reached");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
