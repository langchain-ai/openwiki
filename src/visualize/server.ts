import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { buildGraph, type WikiGraph } from "./graph.js";
import { PAGE } from "./page.js";

const HOST = "127.0.0.1"; // loopback only (never expose the wiki on the network)
const PORT_ATTEMPTS = 20; // ports to try before giving up when the preferred one is busy
const WATCH_DEBOUNCE_MS = 150; // collapse a burst of file-change events into one rebuild

// The client JS is an external module (/client.js), so scripts need only 'self' plus the
// jsdelivr CDN origin for the three browser libraries (whose integrity is pinned by the SRI
// hashes on the <script> tags in page.ts) - no 'unsafe-inline' for scripts. The page still
// carries one inline <style>, so style-src keeps 'unsafe-inline'.
const CDN = "https://cdn.jsdelivr.net";
const CSP = [
  "default-src 'none'",
  `script-src 'self' ${CDN}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * Inputs for a single visualizer server run. Every field is required: the CLI parser
 * fills the defaults, so the server itself never has to guess.
 */
export interface VisualizeServerOptions {
  /**
   * Resolved absolute path to the wiki directory to serve.
   */
  wikiRoot: string;

  /**
   * Preferred TCP port; the server increments from here when it is already in use.
   */
  port: number;

  /**
   * Whether to open the default browser once the server is listening.
   */
  open: boolean;
}

/**
 * Start the visualizer server. Resolves when the server is stopped (SIGINT);
 * exits the process on an unrecoverable listen error, matching the prototype.
 */
export async function runVisualizeServer(
  options: VisualizeServerOptions,
): Promise<void> {
  const { wikiRoot } = options;
  await assertWikiDir(wikiRoot);

  let graph: WikiGraph = {
    root: "",
    generatedAt: "",
    types: [],
    nodes: [],
    edges: [],
  };
  const sseClients = new Set<ServerResponse>();

  // The compiled client modules sit beside this file in dist/visualize/. They are static,
  // server-owned build artifacts (no user input, never evaluated), read once at startup and
  // served verbatim at fixed routes.
  const clientJs = await readFile(
    new URL("./client.js", import.meta.url),
    "utf8",
  );
  const clientLibJs = await readFile(
    new URL("./client-lib.js", import.meta.url),
    "utf8",
  );

  const broadcastReload = (): void => {
    for (const res of sseClients) res.write("event: reload\ndata: 1\n\n");
  };
  const rebuild = async (reason: string): Promise<void> => {
    try {
      graph = await buildGraph(wikiRoot);
      process.stdout.write(
        `  ↻ ${reason}: ${graph.nodes.length} pages, ${graph.edges.length} links\n`,
      );
      broadcastReload();
    } catch (error) {
      process.stderr.write(`  ! rebuild failed: ${(error as Error).message}\n`);
    }
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": CSP,
      });
      res.end(PAGE);
      return;
    }
    if (url === "/client.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(clientJs);
      return;
    }
    if (url === "/client-lib.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(clientLibJs);
      return;
    }
    if (url === "/api/graph") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(graph));
      return;
    }
    if (url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("retry: 2000\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }
    // Only these fixed routes exist; no filesystem path is ever derived from req.url.
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  });

  return new Promise<void>((resolve) => {
    process.once("SIGINT", () => {
      process.stdout.write("\n  stopped.\n");
      server.close(() => resolve());
    });
    listen(server, options.port, PORT_ATTEMPTS, (boundPort) => {
      const url = `http://${HOST}:${boundPort}`;
      void rebuild("initial scan").then(() => {
        startWatch(wikiRoot, rebuild);
        printBanner(wikiRoot, url);
        if (options.open) openBrowser(url);
      });
    });
  });
}

/**
 * Fail early with a friendly message when the wiki directory is missing.
 */
async function assertWikiDir(wikiRoot: string): Promise<void> {
  try {
    const info = await stat(wikiRoot);
    if (!info.isDirectory()) {
      throw new Error(`Not a directory: ${wikiRoot}`);
    }
  } catch {
    throw new Error(
      `Wiki directory not found: ${wikiRoot}. Run \`openwiki --init\` first, or pass a path.`,
    );
  }
}

/**
 * Try the preferred port, incrementing on EADDRINUSE.
 */
function listen(
  server: Server,
  port: number,
  attemptsLeft: number,
  onReady: (port: number) => void,
): void {
  const onError = (err: NodeJS.ErrnoException): void => {
    if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
      listen(server, port + 1, attemptsLeft - 1, onReady);
    } else {
      process.stderr.write(`Failed to start server: ${err.message}\n`);
      process.exit(1);
    }
  };
  server.once("error", onError);
  server.listen(port, HOST, () => {
    server.removeListener("error", onError);
    onReady(port);
  });
}

/**
 * Debounced recursive watch of the wiki directory.
 */
function startWatch(
  wikiRoot: string,
  rebuild: (reason: string) => Promise<void>,
): void {
  let timer: NodeJS.Timeout | undefined;
  try {
    watch(wikiRoot, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => void rebuild("change detected"),
        WATCH_DEBOUNCE_MS,
      );
    });
  } catch {
    process.stdout.write("  (live watch unavailable on this platform)\n");
  }
}

/**
 * Open the default browser without a shell (URL is never interpolated).
 */
function openBrowser(url: string): void {
  const opener: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  execFile(opener[0], opener[1], () => {});
}

/**
 * Print the startup banner: where the wiki lives, the URL, and how to stop.
 */
function printBanner(wikiRoot: string, url: string): void {
  process.stdout.write(`\n  OpenWiki visualizer\n`);
  process.stdout.write(`  wiki:  ${wikiRoot}\n`);
  process.stdout.write(`  open:  \x1b[36m${url}\x1b[0m\n`);
  process.stdout.write(
    `  live:  editing pages under the wiki refreshes the browser\n\n`,
  );
  process.stdout.write(`  Ctrl-C to stop.\n\n`);
}
