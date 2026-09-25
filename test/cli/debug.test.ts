import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  isDebugMode,
  shouldShowCredentialDiagnostics,
} from "../../src/cli/debug.ts";

const DEBUG = "OPENWIKI_DEBUG";
const DEBUG_CREDENTIALS = "OPENWIKI_DEBUG_CREDENTIALS";

describe("debug gates", () => {
  let savedDebug: string | undefined;
  let savedDebugCredentials: string | undefined;

  beforeEach(() => {
    savedDebug = process.env[DEBUG];
    savedDebugCredentials = process.env[DEBUG_CREDENTIALS];
    delete process.env[DEBUG];
    delete process.env[DEBUG_CREDENTIALS];
  });

  afterEach(() => {
    restore(DEBUG, savedDebug);
    restore(DEBUG_CREDENTIALS, savedDebugCredentials);
  });

  test('isDebugMode is true only for exactly "1"', () => {
    expect(isDebugMode()).toBe(false);
    process.env[DEBUG] = "0";
    expect(isDebugMode()).toBe(false);
    process.env[DEBUG] = "true";
    expect(isDebugMode()).toBe(false);
    process.env[DEBUG] = "1";
    expect(isDebugMode()).toBe(true);
  });

  test("shouldShowCredentialDiagnostics honors debug mode", () => {
    process.env[DEBUG] = "1";
    expect(shouldShowCredentialDiagnostics()).toBe(true);
  });

  test("shouldShowCredentialDiagnostics honors the narrow opt-in", () => {
    process.env[DEBUG_CREDENTIALS] = "1";
    expect(shouldShowCredentialDiagnostics()).toBe(true);
  });

  test("shouldShowCredentialDiagnostics is false when neither is set", () => {
    expect(shouldShowCredentialDiagnostics()).toBe(false);
  });
});

/**
 * Restores an env var to its pre-test value, deleting it when it was unset.
 */
function restore(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
