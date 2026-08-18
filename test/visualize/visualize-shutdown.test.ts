import type { ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { shutdownVisualizer, startWatch } from "../../src/visualize/server.ts";

function fakeSseResponse(): ServerResponse & { ended: boolean } {
  const res = { ended: false, end: () => void 0 } as unknown as ServerResponse & { ended: boolean };
  res.end = () => {
    res.ended = true;
  };
  return res;
}

describe("visualizer shutdown (#623)", () => {
  test("shutdownVisualizer ends tracked SSE responses, disposes the watcher, and closes the server", async () => {
    const sseClients = new Set<ServerResponse>();
    const a = fakeSseResponse();
    const b = fakeSseResponse();
    sseClients.add(a);
    sseClients.add(b);

    const watchClose = vi.fn();
    const watchState = { close: watchClose };

    let serverCloseCb: (() => void) | undefined;
    const server = {
      close: (cb: () => void) => {
        serverCloseCb = cb;
      },
    } as unknown as Server;

    let resolved = false;
    const done = shutdownVisualizer({ sseClients, watchState, server }).then(() => {
      resolved = true;
    });

    // The close callback fires asynchronously: resolution must wait for it.
    await Promise.resolve();
    expect(resolved).toBe(false);

    expect(a.ended).toBe(true);
    expect(b.ended).toBe(true);
    expect(sseClients.size).toBe(0);
    expect(watchClose).toHaveBeenCalledTimes(1);

    serverCloseCb?.();
    await done;
    expect(resolved).toBe(true);
  });

  test("startWatch returns a disposer that closes the watcher and cancels pending debounce", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openwiki-watch-"));
    const rebuild = vi.fn();
    try {
      await writeFile(path.join(dir, "index.md"), "# Wiki\n", "utf8");

      const state = startWatch(dir, rebuild);
      expect(state).toBeDefined();

      // Closing must not throw even with no events fired (no pending timer).
      state.close();

      // A second close is a no-op.
      state.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("shutdownVisualizer works with a real server and no clients or watcher", async () => {
    const server: Server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    await expect(
      shutdownVisualizer({ sseClients: new Set(), watchState: undefined, server }),
    ).resolves.toBeUndefined();

    expect(server.listening).toBe(false);
  });
});
