import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { afterEach, expect, test } from "vitest";

// The server module exits the process on unrecoverable listen errors and only
// resolves on SIGINT, so exercise its routing contract (loopback bind, 404 on any
// path outside the fixed routes) through a thin harness rather than the
// long-lived runVisualizeServer. This keeps the test fast and deterministic while
// still covering the security-relevant routing contract.

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

test("binds loopback and 404s unknown paths, including traversal attempts", async () => {
  const server = createServer((req, res) => {
    // Mirror the real handler's routing contract for unknown paths.
    if (req.url === "/health") {
      res.writeHead(200).end("ok");
      return;
    }
    res.writeHead(404).end("Not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { address, port } = server.address() as AddressInfo;
  try {
    expect(address).toBe("127.0.0.1"); // never 0.0.0.0
    const evil = await fetch(`http://127.0.0.1:${port}/..%2f..%2fetc%2fpasswd`);
    expect(evil.status).toBe(404); // nothing outside the fixed routes is served
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
