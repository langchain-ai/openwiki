import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalShellBackend, type ReadResult } from "deepagents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenWikiShellBackend } from "../src/agent/backend.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((tempDir) => rm(tempDir, { force: true, recursive: true })),
  );
});

describe("OpenWikiShellBackend", () => {
  it("returns a text placeholder for png files", async () => {
    const pngContent = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const backend = await createBackend({ "image.png": pngContent });

    const result = await backend.read("/image.png");

    expectBinaryPlaceholder(result, "/image.png", "image/png", 8);
    expect(result.content).not.toBeInstanceOf(Uint8Array);
  });

  it("returns a text placeholder for pyc files", async () => {
    const pycContent = Uint8Array.from([0x42, 0x0d, 0x0d, 0x0a]);
    const backend = await createBackend({ "module.pyc": pycContent });

    const result = await backend.read("/module.pyc");

    expectBinaryPlaceholder(
      result,
      "/module.pyc",
      "application/octet-stream",
      4,
    );
  });

  it("returns normal text files unchanged", async () => {
    const sourceContent = "export const answer = 42;\n";
    const backend = await createBackend({ "source.ts": sourceContent });

    const result = await backend.read("/source.ts");

    expect(result).toEqual({
      content: sourceContent,
      mimeType: "text/plain",
    });
  });

  it("returns a text/plain placeholder for Uint8Array content", async () => {
    const content = Uint8Array.from([1, 2, 3]);
    mockSuperRead({ content, mimeType: "application/octet-stream" });
    const backend = new OpenWikiShellBackend();

    const result = await backend.read("/blob");

    expectBinaryPlaceholder(result, "/blob", "application/octet-stream", 3);
  });

  it("returns a text/plain placeholder for non-Uint8Array binary content", async () => {
    const content = new DataView(new ArrayBuffer(6));
    mockSuperRead({
      content: content as unknown as ReadResult["content"],
      mimeType: "application/octet-stream",
    });
    const backend = new OpenWikiShellBackend();

    const result = await backend.read("/blob");

    expectBinaryPlaceholder(result, "/blob", "application/octet-stream", 6);
  });

  it("returns a placeholder for string content with binary MIME", async () => {
    const content = "base64-ish";
    mockSuperRead({ content, mimeType: "application/octet-stream" });
    const backend = new OpenWikiShellBackend();

    const result = await backend.read("/blob");

    expectBinaryPlaceholder(
      result,
      "/blob",
      "application/octet-stream",
      Buffer.byteLength(content),
    );
  });

  it("passes through string content with text MIME", async () => {
    const readResult: ReadResult = {
      content: "normal source\n",
      mimeType: "text/plain",
    };
    mockSuperRead(readResult);
    const backend = new OpenWikiShellBackend();

    const result = await backend.read("/source");

    expect(result).toBe(readResult);
  });

  it.each([
    "application/json",
    "application/javascript",
    "application/typescript",
    "application/xml",
    undefined,
  ])("passes through source MIME %s", async (mimeType) => {
    const readResult: ReadResult = {
      content: "normal source\n",
      ...(mimeType ? { mimeType } : {}),
    };
    mockSuperRead(readResult);
    const backend = new OpenWikiShellBackend();

    const result = await backend.read("/source");

    expect(result).toBe(readResult);
  });
});

async function createBackend(
  files: Record<string, string | Uint8Array>,
): Promise<OpenWikiShellBackend> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "openwiki-backend-"));
  tempDirs.push(tempDir);

  await Promise.all(
    Object.entries(files).map(([fileName, content]) =>
      writeFile(path.join(tempDir, fileName), content),
    ),
  );

  return new OpenWikiShellBackend({
    rootDir: tempDir,
    virtualMode: true,
  });
}

function mockSuperRead(result: ReadResult): void {
  vi.spyOn(LocalShellBackend.prototype, "read").mockResolvedValue(result);
}

function expectBinaryPlaceholder(
  result: ReadResult,
  filePath: string,
  mimeType: string,
  byteLength: number,
): void {
  expect(result).toEqual({
    content: `Binary file skipped: ${filePath} (${mimeType}, ${byteLength} bytes). OpenWiki reads text sources only.`,
    mimeType: "text/plain",
  });
}
