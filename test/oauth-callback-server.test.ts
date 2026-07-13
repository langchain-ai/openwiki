import { once } from "node:events";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createCallbackServer } from "../src/auth/oauth.ts";
import { getAuthProvider } from "../src/auth/providers.ts";

// `createCallbackServer` backs `openwiki auth <provider>`: it captures the
// OAuth redirect on a loopback HTTP server, then the server is closed while
// the browser may still be sending follow-up requests (such as a favicon
// fetch). A request that finishes parsing after close() has started used to
// crash the whole CLI, because the handler read `server.address().port` and
// `server.address()` returns null once the server stops listening.

const CALLBACK_PORT_ENV_KEY = "OPENWIKI_OAUTH_CALLBACK_PORT";

let originalCallbackPort: string | undefined;
let port: number;

beforeEach(async () => {
  originalCallbackPort = process.env[CALLBACK_PORT_ENV_KEY];
  port = await findFreePort();
  process.env[CALLBACK_PORT_ENV_KEY] = String(port);
});

afterEach(() => {
  if (originalCallbackPort === undefined) {
    delete process.env[CALLBACK_PORT_ENV_KEY];
  } else {
    process.env[CALLBACK_PORT_ENV_KEY] = originalCallbackPort;
  }
});

async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address() as net.AddressInfo;
      probe.close(() => resolve(address.port));
    });
  });
}

describe("createCallbackServer", () => {
  test("resolves the authorization code from the OAuth redirect", async () => {
    const callback = await createCallbackServer(getAuthProvider("gmail"));

    try {
      const codePromise = callback.waitForCode("expected-state");
      const redirect = await fetch(
        `http://127.0.0.1:${port}/callback?code=test-code&state=expected-state`,
      );

      expect(redirect.status).toBe(200);
      await expect(codePromise).resolves.toBe("test-code");
    } finally {
      await callback.close();
    }
  });

  test("answers a trailing request that arrives while the server is closing", async () => {
    const callback = await createCallbackServer(getAuthProvider("gmail"));
    const codePromise = callback.waitForCode("expected-state");
    await fetch(
      `http://127.0.0.1:${port}/callback?code=test-code&state=expected-state`,
    );
    await codePromise;

    // Reproduce the shutdown race deterministically: start sending a request
    // so the connection is no longer idle, begin closing the server — from
    // here server.address() returns null — then let the request finish
    // parsing so the handler runs mid-shutdown.
    const socket = net.connect(port, "127.0.0.1");
    await once(socket, "connect");
    socket.write("GET /favicon.ico HTTP/1.1\r\n");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const closePromise = callback.close();
    socket.write("Host: 127.0.0.1\r\nConnection: close\r\n\r\n");

    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    await once(socket, "close");
    await closePromise;

    const response = Buffer.concat(chunks).toString();
    expect(response).toMatch(/^HTTP\/1\.1 400 /);
    expect(response).toContain("missing required data");
  });
});
