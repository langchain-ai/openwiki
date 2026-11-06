import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

type WatchCallback = (
  eventType: string,
  filename: string | Buffer | null,
) => void;

const watcherState: {
  close: ReturnType<typeof vi.fn>;
  callback: WatchCallback | undefined;
} = vi.hoisted(() => ({
  close: vi.fn(),
  callback: undefined as WatchCallback | undefined,
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  watch: vi.fn((_path: string, _options: object, listener: WatchCallback) => {
    watcherState.callback = listener;
    return { close: watcherState.close };
  }),
}));

vi.mock("../../src/visualize/static-export.js", () => ({
  loadVisualizerAssets: vi.fn(() =>
    Promise.resolve({
      clientJs: "/* client */",
      clientLibJs: "/* client-lib */",
      stylesCss: "/* styles */",
    }),
  ),
}));

import { runVisualizeServer } from "../../src/visualize/server.ts";

const tempDirs: string[] = [];

beforeEach(() => {
  watcherState.close.mockReset();
  watcherState.callback = undefined;
});

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

async function makeWiki(): Promise<string> {
  const wikiRoot = await mkdtemp(path.join(tmpdir(), "openwiki-viz-shutdown-"));
  tempDirs.push(wikiRoot);
  await writeFile(path.join(wikiRoot, "index.md"), "# Home\n", "utf8");
  return wikiRoot;
}

async function findOpenPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("Expected the probe server to bind a TCP port");
  }
  const { port } = address;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 2000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/graph`);
      await response.arrayBuffer();
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await delay(25);
  }
  throw new Error(
    `visualizer server did not start: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function removeNewSigintListeners(previous: NodeJS.SignalsListener[]): void {
  for (const listener of process.listeners("SIGINT")) {
    if (!previous.includes(listener)) {
      process.removeListener("SIGINT", listener);
    }
  }
}

test("SIGINT resolves the visualizer server while an SSE stream is open", async () => {
  const previousSigintListeners = process.listeners("SIGINT");
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  const wikiRoot = await makeWiki();
  const port = await findOpenPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const runPromise = runVisualizeServer({ wikiRoot, port, open: false });

  try {
    await waitForServer(baseUrl);
    await vi.waitFor(() => expect(watcherState.callback).toBeDefined());

    const response = await fetch(`${baseUrl}/events`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.body).not.toBeNull();

    reader = response.body.getReader();
    const initial = await withTimeout(
      reader.read(),
      1000,
      "SSE stream did not send its initial retry frame",
    );
    expect(new TextDecoder().decode(initial.value)).toContain("retry: 2000");
    watcherState.callback?.("change", "index.md");

    process.emit("SIGINT");

    await withTimeout(
      runPromise,
      1000,
      "visualizer server did not stop after SIGINT",
    );
    const afterShutdown = await withTimeout(
      reader.read(),
      1000,
      "SSE stream did not end after SIGINT",
    );

    expect(afterShutdown.done).toBe(true);
    expect(watcherState.close).toHaveBeenCalledOnce();
    await delay(200);
    const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain("stopped.");
    expect(output).not.toContain("change detected");
  } finally {
    controller.abort();
    reader?.releaseLock();
    if (
      process
        .listeners("SIGINT")
        .some((listener) => !previousSigintListeners.includes(listener))
    ) {
      process.emit("SIGINT");
    }
    await Promise.race([runPromise.catch(() => undefined), delay(500)]);
    removeNewSigintListeners(previousSigintListeners);
    stdout.mockRestore();
  }
});
