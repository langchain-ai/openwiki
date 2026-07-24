import { beforeEach, describe, expect, test, vi } from "vitest";

// Mock the filesystem so the install-id lifecycle is tested in isolation,
// without touching the developer's real ~/.openwiki.
const fsMock = vi.hoisted(() => ({
  chmod: vi.fn(() => Promise.resolve(undefined)),
  mkdir: vi.fn(() => Promise.resolve(undefined)),
  readFile: vi.fn(),
  writeFile: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("node:fs/promises", () => fsMock);

import { getOrCreateInstallId } from "../src/telemetry/install-id.ts";

const UUID = /^[0-9a-f-]{36}$/i;

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error("missing"), { code: "ENOENT" });
}

beforeEach(() => {
  fsMock.chmod.mockClear();
  fsMock.mkdir.mockClear();
  fsMock.readFile.mockReset();
  fsMock.writeFile.mockClear();
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
});
