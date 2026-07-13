import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type CallbackHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void;

const httpMock = vi.hoisted(() => {
  let handler: CallbackHandler | null = null;
  let address: { address: string; family: string; port: number } | null = {
    address: "127.0.0.1",
    family: "IPv4",
    port: 53682,
  };

  const server = {
    address: vi.fn(() => address),
    close: vi.fn((callback: (error?: Error) => void) => {
      address = null;
      callback();
    }),
    closeAllConnections: vi.fn(),
    closeIdleConnections: vi.fn(),
    listen: vi.fn(
      (_port: number, _host: string, callback: () => void): typeof server => {
        callback();
        return server;
      },
    ),
    once: vi.fn(() => server),
  };

  return {
    createServer: vi.fn((nextHandler: CallbackHandler) => {
      handler = nextHandler;
      return server;
    }),
    getHandler: () => handler,
    reset: () => {
      handler = null;
      address = {
        address: "127.0.0.1",
        family: "IPv4",
        port: 53682,
      };
      for (const value of Object.values(server)) {
        if (typeof value === "function" && "mockClear" in value) {
          value.mockClear();
        }
      }
    },
    server,
  };
});

const envMock = vi.hoisted(() => ({
  loadOpenWikiEnv: vi.fn(() => Promise.resolve({})),
  saveOpenWikiEnv: vi.fn(() => Promise.resolve(undefined)),
}));

const childProcessMock = vi.hoisted(() => ({
  execFile: vi.fn(
    (
      _command: string,
      _args: string[],
      callback: (error: Error | null) => void,
    ) => {
      callback(new Error("browser unavailable"));
      return {
        stdin: {
          end: vi.fn(),
        },
      };
    },
  ),
}));

vi.mock("node:http", () => ({
  default: {
    createServer: httpMock.createServer,
  },
}));

vi.mock("node:child_process", () => ({
  execFile: childProcessMock.execFile,
}));

vi.mock("../src/env.js", () => envMock);

const originalGoogleClientId = process.env.OPENWIKI_GOOGLE_CLIENT_ID;
const originalGoogleClientSecret = process.env.OPENWIKI_GOOGLE_CLIENT_SECRET;

beforeEach(() => {
  httpMock.reset();
  envMock.loadOpenWikiEnv.mockClear();
  envMock.saveOpenWikiEnv.mockClear();
  childProcessMock.execFile.mockClear();
  process.env.OPENWIKI_GOOGLE_CLIENT_ID = "client-id";
  process.env.OPENWIKI_GOOGLE_CLIENT_SECRET = "client-secret";
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        json: () =>
          Promise.resolve({
            access_token: "access-token",
            expires_in: 3600,
            refresh_token: "refresh-token",
            token_type: "Bearer",
          }),
        ok: true,
        status: 200,
      }),
    ),
  );
});

afterEach(() => {
  if (originalGoogleClientId === undefined) {
    delete process.env.OPENWIKI_GOOGLE_CLIENT_ID;
  } else {
    process.env.OPENWIKI_GOOGLE_CLIENT_ID = originalGoogleClientId;
  }

  if (originalGoogleClientSecret === undefined) {
    delete process.env.OPENWIKI_GOOGLE_CLIENT_SECRET;
  } else {
    process.env.OPENWIKI_GOOGLE_CLIENT_SECRET = originalGoogleClientSecret;
  }

  vi.unstubAllGlobals();
});

function createResponse() {
  return {
    end: vi.fn(),
    writeHead: vi.fn(),
  };
}

describe("OAuth callback server", () => {
  test("handles trailing requests after close without reading server.address()", async () => {
    const { runOAuthAuth } = await import("../src/auth/oauth.ts");

    await runOAuthAuth("gmail", {
      onAuthorizationUrl: ({ url }) => {
        const state = new URL(url).searchParams.get("state");
        const handler = httpMock.getHandler();
        expect(state).toBeTruthy();
        expect(handler).toBeTruthy();

        handler?.(
          {
            url: `/callback?code=auth-code&state=${state}`,
          } as IncomingMessage,
          createResponse() as unknown as ServerResponse,
        );
      },
      silent: true,
    });

    expect(httpMock.server.close).toHaveBeenCalledTimes(1);
    expect(httpMock.server.address()).toBeNull();

    const trailingResponse = createResponse();
    expect(() =>
      httpMock.getHandler()?.(
        { url: "/favicon.ico" } as IncomingMessage,
        trailingResponse as unknown as ServerResponse,
      ),
    ).not.toThrow();
    expect(trailingResponse.writeHead).toHaveBeenCalledWith(
      400,
      expect.any(Object),
    );
  });
});
