import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { OpenWikiLocalShellBackend } from "../src/agent/openwiki-backend.ts";

async function createRepoFile(fileName: string, content: Buffer | string) {
  const repo = await mkdtemp(path.join(tmpdir(), "openwiki-backend-"));
  await writeFile(path.join(repo, fileName), content);

  return {
    backend: new OpenWikiLocalShellBackend({
      rootDir: repo,
      virtualMode: true,
    }),
    virtualPath: `/${fileName}`,
  };
}

describe("OpenWikiLocalShellBackend", () => {
  test.each([
    [".env.example"],
    [".prettierrc"],
    [".trivyignore"],
    [".gitignore"],
    ["Dockerfile"],
    ["query.snap"],
  ])("reads textual repository config files as text: %s", async (fileName) => {
    const { backend, virtualPath } = await createRepoFile(
      fileName,
      "EXAMPLE=value\n",
    );

    const result = await backend.read(virtualPath);

    expect(result).toMatchObject({
      content: "EXAMPLE=value\n",
      mimeType: "text/plain",
    });
  });

  test("keeps unknown binary files as binary", async () => {
    const { backend, virtualPath } = await createRepoFile(
      "archive.custom",
      Buffer.from([0x00, 0x01, 0x02, 0xff]),
    );

    const result = await backend.read(virtualPath);

    expect(result.content).toBeInstanceOf(Uint8Array);
    expect(result.mimeType).toBe("application/octet-stream");
  });
});
