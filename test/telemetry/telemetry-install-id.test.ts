import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock the filesystem so the install-id lifecycle is tested in isolation,
// without touching the developer's real ~/.openwiki.
const fsMock = vi.hoisted(() => ({
  chmod: vi.fn(() => Promise.resolve(undefined)),
  mkdir: vi.fn(() => Promise.resolve(undefined)),
  readFile: vi.fn(),
  writeFile: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("node:fs/promises", () => fsMock);

// Pin CI detection off so `noticeSuppressed()` is driven only by the env vars
// this test controls; otherwise a run under GitHub Actions would suppress the
// notice and flip the "pending" assertions.
vi.mock("ci-info", () => ({ default: { isCI: false, name: null } }));

import {
  firstRunNoticePending,
  getOrCreateInstallId,
} from "../../src/telemetry/install-id.ts";

const UUID = /^[0-9a-f-]{36}$/i;

const OPT_OUT_KEYS = [
  "OPENWIKI_TELEMETRY_DISABLED",
  "DO_NOT_TRACK",
  "OPENWIKI_SCHEDULED",
] as const;

let savedEnv: Record<string, string | undefined>;

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error("missing"), { code: "ENOENT" });
}

beforeEach(() => {
  fsMock.chmod.mockClear();
  fsMock.mkdir.mockClear();
  fsMock.readFile.mockReset();
  fsMock.writeFile.mockClear();

  savedEnv = {};
  for (const key of OPT_OUT_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of OPT_OUT_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

describe("getOrCreateInstallId", () => {
  test("mints a new id on first use and persists it 0600", async () => {
    fsMock.readFile.mockRejectedValueOnce(enoent());

    const { id, isNew } = await getOrCreateInstallId();

    expect(isNew).toBe(true);
    expect(id).toMatch(UUID);
    expect(fsMock.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("install-id"),
      `${id}\n`,
      expect.objectContaining({ mode: 0o600 }),
    );
  });

  test("reuses an existing id without minting", async () => {
    fsMock.readFile.mockResolvedValueOnce("existing-id\n");

    const { id, isNew } = await getOrCreateInstallId();

    expect(isNew).toBe(false);
    expect(id).toBe("existing-id");
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  test("treats a blank file as absent and mints", async () => {
    fsMock.readFile.mockResolvedValueOnce("  \n");

    const { isNew } = await getOrCreateInstallId();

    expect(isNew).toBe(true);
    expect(fsMock.writeFile).toHaveBeenCalledOnce();
  });

  test("rethrows a read failure that is not a missing file", async () => {
    // A permission error means the id may actually exist; minting a fresh one
    // and overwriting would be wrong, so the error propagates instead.
    fsMock.readFile.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { code: "EACCES" }),
    );

    await expect(getOrCreateInstallId()).rejects.toThrow(/denied/u);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });
});

describe("firstRunNoticePending", () => {
  test("returns false and mints nothing when the notice is suppressed", async () => {
    process.env.OPENWIKI_TELEMETRY_DISABLED = "1";

    expect(await firstRunNoticePending()).toBe(false);
    // Suppression short-circuits before any id lookup, so the store is untouched.
    expect(fsMock.readFile).not.toHaveBeenCalled();
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  test("is pending only on the run that mints the id", async () => {
    fsMock.readFile.mockRejectedValueOnce(enoent());
    expect(await firstRunNoticePending()).toBe(true);

    fsMock.readFile.mockResolvedValueOnce("existing-id\n");
    expect(await firstRunNoticePending()).toBe(false);
  });

  test("never throws even if the id store read fails hard", async () => {
    // Telemetry must never break a run: a non-ENOENT read failure is swallowed
    // and reported as "no notice" rather than propagating.
    fsMock.readFile.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { code: "EACCES" }),
    );

    await expect(firstRunNoticePending()).resolves.toBe(false);
  });
});
