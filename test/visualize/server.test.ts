import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createRequestHandler } from "../../src/visualize/server.ts";
import type { WikiGraph } from "../../src/visualize/graph.ts";
import { PAGE } from "../../src/visualize/page.ts";

/**
 * A minimal wiki graph. The handler only serializes it, so the exact shape is
 * irrelevant beyond being JSON-round-trippable.
 */
function makeGraph(root: string): WikiGraph {
  return { root, generatedAt: "", types: [], nodes: [], edges: [] };
}

/**
 * A captured HTTP response: records the status, headers, and body written by the
 * handler so tests can assert on them without a real socket.
 */
interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
  res: ServerResponse;
}

/**
 * Build a fake `ServerResponse` that records everything the handler writes.
 */
function makeResponse(): CapturedResponse {
  const captured: CapturedResponse = {
    statusCode: 0,
    headers: {},
    body: "",
    ended: false,
    // Assigned below once the recording methods exist.
    res: undefined as unknown as ServerResponse,
  };

  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.statusCode = status;
      if (headers) Object.assign(captured.headers, headers);
      return res;
    },
    write(chunk: string) {
      captured.body += chunk;
      return true;
    },
    end(chunk?: string) {
      if (chunk) captured.body += chunk;
      captured.ended = true;
      return res;
    },
  };

  captured.res = res as unknown as ServerResponse;
  return captured;
}

/**
 * Build a fake `IncomingMessage` for a given URL, capturing any `close` listener
 * the handler registers (used by the SSE route).
 */
function makeRequest(url: string): {
  req: IncomingMessage;
  closeListener: () => void;
} {
  let closeListener: () => void = () => {};
  const req = {
    url,
    on(event: string, listener: () => void) {
      if (event === "close") closeListener = listener;
      return req;
    },
  };
  return {
    req: req as unknown as IncomingMessage,
    get closeListener() {
      return closeListener;
    },
  };
}

describe("createRequestHandler", () => {
  let sseClients: Set<ServerResponse>;
  let graph: WikiGraph;
  let handler: (req: IncomingMessage, res: ServerResponse) => void;

  beforeEach(() => {
    sseClients = new Set<ServerResponse>();
    graph = makeGraph("/wiki");
    handler = createRequestHandler({
      getGraph: () => graph,
      clientJs: "/* client */",
      clientLibJs: "/* client-lib */",
      stylesCss: "/* styles */",
      sseClients,
    });
  });

  test.each(["/", "/index.html"])(
    "%s serves the page with the strict CSP header",
    (url) => {
      const { req } = makeRequest(url);
      const out = makeResponse();

      handler(req, out.res);

      expect(out.statusCode).toBe(200);
      expect(out.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(out.body).toBe(PAGE);

      // The CSP must lock scripts to self + the jsdelivr CDN with no inline
      // scripts; only styles may be inline. This is the anti-XSS/supply-chain
      // boundary and must not drift.
      const csp = out.headers["content-security-policy"];
      expect(csp).toBe(
        [
          "default-src 'none'",
          "script-src 'self' https://cdn.jsdelivr.net",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data:",
          "font-src 'self'",
          "connect-src 'self'",
          "base-uri 'none'",
          "form-action 'none'",
        ].join("; "),
      );
      expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    },
  );

  test("/client.js serves the injected client module", () => {
    const { req } = makeRequest("/client.js");
    const out = makeResponse();

    handler(req, out.res);

    expect(out.statusCode).toBe(200);
    expect(out.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(out.body).toBe("/* client */");
  });

  test("/client-lib.js serves the injected client-lib module", () => {
    const { req } = makeRequest("/client-lib.js");
    const out = makeResponse();

    handler(req, out.res);

    expect(out.statusCode).toBe(200);
    expect(out.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(out.body).toBe("/* client-lib */");
  });

  test("/styles.css serves the injected stylesheet", () => {
    const { req } = makeRequest("/styles.css");
    const out = makeResponse();

    handler(req, out.res);

    expect(out.statusCode).toBe(200);
    expect(out.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(out.body).toBe("/* styles */");
  });

  test("/api/graph serves the live graph as JSON", () => {
    const { req } = makeRequest("/api/graph");
    const out = makeResponse();

    handler(req, out.res);

    expect(out.statusCode).toBe(200);
    expect(out.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(JSON.parse(out.body)).toEqual(graph);
  });

  test("/api/graph reflects a graph rebuild between requests", () => {
    const first = makeResponse();
    handler(makeRequest("/api/graph").req, first.res);
    expect((JSON.parse(first.body) as WikiGraph).root).toBe("/wiki");

    // Simulate a live rebuild reassigning the graph the server closes over.
    graph = makeGraph("/wiki-rebuilt");

    const second = makeResponse();
    handler(makeRequest("/api/graph").req, second.res);
    expect((JSON.parse(second.body) as WikiGraph).root).toBe("/wiki-rebuilt");
  });

  test("/events opens an SSE stream and tracks the subscriber", () => {
    const request = makeRequest("/events");
    const out = makeResponse();

    handler(request.req, out.res);

    expect(out.statusCode).toBe(200);
    expect(out.headers["content-type"]).toBe("text/event-stream");
    expect(out.headers["cache-control"]).toBe("no-cache");
    expect(out.body).toContain("retry: 2000");
    expect(sseClients.has(out.res)).toBe(true);

    // The close listener drops the subscriber so we never write to a dead socket.
    request.closeListener();
    expect(sseClients.has(out.res)).toBe(false);
  });

  test("an unknown route is a 404, never a filesystem read", () => {
    const { req } = makeRequest("/does-not-exist");
    const out = makeResponse();

    handler(req, out.res);

    expect(out.statusCode).toBe(404);
    expect(out.headers["content-type"]).toBe("text/plain");
    expect(out.body).toBe("Not found");
  });

  // No route derives a path from req.url, so traversal-shaped URLs get the same
  // flat 404 as any other unknown route - they can never escape to the filesystem.
  test.each([
    "/../../etc/passwd",
    "/%2e%2e/%2e%2e/etc/passwd",
    "/client.js/../../../secret",
    "/api/graph/../../etc/passwd",
    "/styles.css/../../../secret",
  ])("path-traversal attempt %s is a 404", (url) => {
    const { req } = makeRequest(url);
    const out = makeResponse();

    handler(req, out.res);

    expect(out.statusCode).toBe(404);
    expect(out.body).toBe("Not found");
  });

  test("a missing req.url defaults to the index page", () => {
    const req = { url: undefined, on: vi.fn() } as unknown as IncomingMessage;
    const out = makeResponse();

    handler(req, out.res);

    expect(out.statusCode).toBe(200);
    expect(out.body).toBe(PAGE);
  });
});
