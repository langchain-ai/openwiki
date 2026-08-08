import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// runOAuthAuth is the orchestrator that ties together the whole authorization
// code + PKCE flow. Every external effect it has is mocked so the flow runs
// end-to-end without ever leaving the machine: the env file is never written,
// no `open`/`pbcopy` subprocess is spawned, and the only real socket is the
// loopback callback server the code binds on 127.0.0.1. `fetch` is stubbed with
// a URL router that returns synthetic discovery / registration / token JSON, so
// the assertions can inspect exactly what the flow sent (PKCE challenge, state,
// code_verifier) without contacting a real provider.

// loadOpenWikiEnv/saveOpenWikiEnv are mocked so no test reads or writes the
// user's real ~/.openwiki/.env; saveOpenWikiEnv is a spy so the token->env
// mapping the flow persists can be asserted directly.
const loadOpenWikiEnvMock = vi.hoisted(() => vi.fn(() => Promise.resolve({})));
const saveOpenWikiEnvMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../../src/config/env.ts", () => ({
  loadOpenWikiEnv: loadOpenWikiEnvMock,
  saveOpenWikiEnv: saveOpenWikiEnvMock,
}));

// openBrowser/copyToClipboard shell out through execFile; the mock hands back a
// fake child (with a no-op stdin) and reports success so the suite never
// launches `open`, `xdg-open`, `rundll32`, or `pbcopy`. Calls are recorded so
// the argv can be asserted: execFile (not exec) with an explicit args array
// means the authorization URL's `&` separators are passed verbatim and never
// reinterpreted by a shell.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import net from "node:net";
import { runOAuthAuth } from "../../src/auth/oauth.ts";

const CALLBACK_PORT_ENV_KEY = "OPENWIKI_OAUTH_CALLBACK_PORT";
const GOOGLE_CLIENT_ID_ENV_KEY = "OPENWIKI_GOOGLE_CLIENT_ID";
const GOOGLE_CLIENT_SECRET_ENV_KEY = "OPENWIKI_GOOGLE_CLIENT_SECRET";

// The real loopback callback must be driven by a genuine HTTP client, but the
// test stubs global fetch with the provider router. Capturing the original
// fetch first lets the callback request bypass that router and hit 127.0.0.1.
const realFetch = globalThis.fetch;

const NOTION_AUTH_ENDPOINT = "https://mcp.notion.com/authorize";
const NOTION_TOKEN_ENDPOINT = "https://api.notion.com/v1/oauth/token";
const NOTION_REGISTRATION_ENDPOINT = "https://api.notion.com/v1/oauth/register";
const GMAIL_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

type FetchCall = {
  body: unknown;
  method: string;
  url: string;
};

type RouterOptions = {
  registrationNoClientId?: boolean;
  registrationStatus?: number;
  tokenPayload?: unknown;
  tokenStatus?: number;
};

let port: number;
let savedEnv: Record<string, string | undefined>;
// Captured from the saveOpenWikiEnv spy so the persisted token->env mapping can
// be inspected with a real type instead of reaching into `any` mock.calls.
let persistedUpdates: Record<string, string> | undefined;

/**
 * Reserves and releases an ephemeral loopback port so each flow binds its own
 * callback server and concurrent test files never collide on the fixed default.
 */
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

/**
 * Builds a JSON Response the stubbed fetch can return for discovery,
 * registration, and token endpoints.
 */
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
    status,
  });
}

/**
 * Installs a fetch stub that routes provider traffic to synthetic responses and
 * records every call so the test can assert the PKCE code_verifier, resource
 * binding, and client authentication the flow sent.
 */
function installFetchRouter(options: RouterOptions = {}): FetchCall[] {
  const calls: FetchCall[] = [];
  // The flow only ever calls fetch with a string or URL, so the mock narrows to
  // those and returns a Response synchronously (an awaited non-promise resolves
  // fine) to keep the router free of a needless async wrapper.
  const fetchMock = vi.fn((input: string | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.href;
    calls.push({ body: init.body, method: init.method ?? "GET", url });

    if (url.includes(".well-known/oauth-protected-resource")) {
      return jsonResponse({
        authorization_servers: ["https://mcp.notion.com"],
      });
    }

    if (
      url.includes(".well-known/oauth-authorization-server") ||
      url.includes(".well-known/openid-configuration")
    ) {
      return jsonResponse({
        authorization_endpoint: NOTION_AUTH_ENDPOINT,
        registration_endpoint: NOTION_REGISTRATION_ENDPOINT,
        token_endpoint: NOTION_TOKEN_ENDPOINT,
      });
    }

    if (url === NOTION_REGISTRATION_ENDPOINT) {
      if (options.registrationStatus && options.registrationStatus !== 200) {
        return jsonResponse({}, options.registrationStatus);
      }
      if (options.registrationNoClientId) {
        return jsonResponse({});
      }
      return jsonResponse({ client_id: "notion-client-123" });
    }

    if (url === NOTION_TOKEN_ENDPOINT || url === GMAIL_TOKEN_ENDPOINT) {
      if (options.tokenStatus && options.tokenStatus !== 200) {
        return jsonResponse({ error: "invalid_grant" }, options.tokenStatus);
      }
      return jsonResponse(options.tokenPayload ?? {});
    }

    throw new Error(`unexpected fetch to ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

/**
 * Starts runOAuthAuth and exposes a promise that resolves with the
 * authorization URL event once the flow reaches the "waiting for callback"
 * stage, so the test can read the generated state and drive the loopback
 * redirect deterministically (the server is already bound by this point).
 */
function startRun(providerId: "gmail" | "notion"): {
  runPromise: Promise<unknown>;
  urlReady: Promise<{
    copiedToClipboard: boolean;
    openedBrowser: boolean;
    url: string;
  }>;
} {
  let resolveUrl: (event: {
    copiedToClipboard: boolean;
    openedBrowser: boolean;
    url: string;
  }) => void;
  const urlReady = new Promise<{
    copiedToClipboard: boolean;
    openedBrowser: boolean;
    url: string;
  }>((resolve) => {
    resolveUrl = resolve;
  });

  const runPromise = runOAuthAuth(providerId, {
    onAuthorizationUrl: (event) => {
      resolveUrl({
        copiedToClipboard: event.copiedToClipboard,
        openedBrowser: event.openedBrowser,
        url: event.url,
      });
    },
    silent: true,
  });

  return { runPromise, urlReady };
}

/**
 * Sends the OAuth provider's redirect to the loopback callback with the given
 * state and code, standing in for the browser the flow would otherwise open.
 */
async function driveCallback(state: string, code: string): Promise<void> {
  await realFetch(
    `http://127.0.0.1:${port}/callback?code=${encodeURIComponent(
      code,
    )}&state=${encodeURIComponent(state)}`,
  );
}

/**
 * Returns the recorded token-exchange call for a given endpoint, whose body
 * carries the PKCE code_verifier and (for confidential clients) the secret.
 */
function tokenCall(calls: FetchCall[], endpoint: string): FetchCall {
  const call = calls.find((entry) => entry.url === endpoint);
  if (!call) {
    throw new Error(`no token exchange recorded for ${endpoint}`);
  }
  return call;
}

beforeEach(async () => {
  port = await findFreePort();
  savedEnv = {
    [CALLBACK_PORT_ENV_KEY]: process.env[CALLBACK_PORT_ENV_KEY],
    [GOOGLE_CLIENT_ID_ENV_KEY]: process.env[GOOGLE_CLIENT_ID_ENV_KEY],
    [GOOGLE_CLIENT_SECRET_ENV_KEY]: process.env[GOOGLE_CLIENT_SECRET_ENV_KEY],
  };
  process.env[CALLBACK_PORT_ENV_KEY] = String(port);

  persistedUpdates = undefined;
  saveOpenWikiEnvMock.mockImplementation((updates: Record<string, string>) => {
    persistedUpdates = updates;
    return Promise.resolve();
  });

  // execFile always "succeeds" with a fake child; the stdin end() is a no-op so
  // copyToClipboard's pipe write has somewhere to go without a real pbcopy.
  execFileMock.mockImplementation(
    (
      _command: string,
      _args: string[],
      callback: (error: Error | null) => void,
    ) => {
      queueMicrotask(() => callback(null));
      return { stdin: { end: vi.fn() } };
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  execFileMock.mockReset();
  loadOpenWikiEnvMock.mockClear();
  saveOpenWikiEnvMock.mockClear();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("runOAuthAuth authorization code + PKCE flow", () => {
  test("completes the Gmail confidential-client flow and persists the token mapping", async () => {
    process.env[GOOGLE_CLIENT_ID_ENV_KEY] = "gmail-client";
    process.env[GOOGLE_CLIENT_SECRET_ENV_KEY] = "gmail-secret";
    const calls = installFetchRouter({
      tokenPayload: {
        access_token: "gmail-access",
        expires_in: 3600,
        refresh_token: "gmail-refresh",
        token_type: "Bearer",
      },
    });

    const { runPromise, urlReady } = startRun("gmail");
    const event = await urlReady;
    const authUrl = new URL(event.url);

    // The authorization request must carry a hashed PKCE challenge (S256), never
    // the raw verifier, plus an unguessable state that binds the later redirect
    // to this process (CSRF integrity).
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("response_type")).toBe("code");
    expect(authUrl.searchParams.get("client_id")).toBe("gmail-client");
    expect(authUrl.searchParams.get("redirect_uri")).toBe(
      `http://127.0.0.1:${port}/callback`,
    );
    const state = authUrl.searchParams.get("state");
    const challenge = authUrl.searchParams.get("code_challenge");
    expect(state).toBeTruthy();
    expect(challenge).toBeTruthy();

    // openBrowser reported success and did so via an explicit argv, not a shell
    // string: the last argument is the verbatim URL and the third execFile arg
    // is the completion callback (no options object, so shell defaults false).
    expect(event.openedBrowser).toBe(true);
    const browserCall = execFileMock.mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1].at(-1) === event.url,
    );
    expect(browserCall).toBeDefined();
    expect(typeof browserCall?.[2]).toBe("function");

    await driveCallback(state as string, "gmail-auth-code");
    const result = await runPromise;

    // The token request must present the code_verifier whose SHA-256 equals the
    // challenge advertised in the authorization URL: that pairing is what proves
    // the redeeming client is the one that started the flow.
    const exchange = tokenCall(calls, GMAIL_TOKEN_ENDPOINT);
    const body = exchange.body as URLSearchParams;
    const verifier = body.get("code_verifier") as string;
    expect(verifier).toBeTruthy();
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      challenge,
    );
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("gmail-auth-code");
    // client_secret_post providers authenticate the token call with the secret.
    expect(body.get("client_secret")).toBe("gmail-secret");
    expect(body.get("redirect_uri")).toBe(`http://127.0.0.1:${port}/callback`);

    expect(saveOpenWikiEnvMock).toHaveBeenCalledTimes(1);
    expect(saveOpenWikiEnvMock).toHaveBeenCalledWith(
      expect.objectContaining({
        OPENWIKI_GMAIL_ACCESS_TOKEN: "gmail-access",
        OPENWIKI_GMAIL_REFRESH_TOKEN: "gmail-refresh",
        OPENWIKI_GMAIL_TOKEN_TYPE: "Bearer",
      }),
    );
    // expires_in is converted to an absolute ISO expiry before it is stored.
    expect(typeof persistedUpdates?.OPENWIKI_GMAIL_TOKEN_EXPIRES_AT).toBe(
      "string",
    );
    const gmailResult = result as {
      provider: string;
      savedEnvKeys: string[];
    };
    expect(gmailResult.provider).toBe("gmail");
    expect(gmailResult.savedEnvKeys).toContain("OPENWIKI_GMAIL_ACCESS_TOKEN");
    expect(gmailResult.savedEnvKeys).toContain("OPENWIKI_GMAIL_REFRESH_TOKEN");
  });

  test("registers a Notion MCP client dynamically, binds the resource, and stores the client id", async () => {
    const calls = installFetchRouter({
      tokenPayload: {
        access_token: "notion-access",
        expires_in: 3600,
        refresh_token: "notion-refresh",
        token_type: "bearer",
      },
    });

    const { runPromise, urlReady } = startRun("notion");
    const event = await urlReady;
    const authUrl = new URL(event.url);

    // Dynamic client registration must have produced the client_id used in the
    // authorization request, and the MCP resource must be bound into the URL so
    // the issued token is audience-restricted to Notion's MCP endpoint.
    expect(authUrl.origin + authUrl.pathname).toBe(NOTION_AUTH_ENDPOINT);
    expect(authUrl.searchParams.get("client_id")).toBe("notion-client-123");
    expect(authUrl.searchParams.get("resource")).toBe(
      "https://mcp.notion.com/mcp",
    );
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const state = authUrl.searchParams.get("state") as string;
    const challenge = authUrl.searchParams.get("code_challenge");

    const registration = calls.find(
      (call) => call.url === NOTION_REGISTRATION_ENDPOINT,
    );
    expect(registration?.method).toBe("POST");

    await driveCallback(state, "notion-auth-code");
    const result = await runPromise;

    const exchange = tokenCall(calls, NOTION_TOKEN_ENDPOINT);
    const body = exchange.body as URLSearchParams;
    const verifier = body.get("code_verifier") as string;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      challenge,
    );
    // A public (token_endpoint_auth_method "none") client sends no secret, and
    // the token request repeats the resource binding.
    expect(body.get("client_secret")).toBeNull();
    expect(body.get("resource")).toBe("https://mcp.notion.com/mcp");

    // The registered client_id is persisted alongside the tokens so refreshes
    // can reuse the same dynamic registration.
    expect(saveOpenWikiEnvMock).toHaveBeenCalledWith(
      expect.objectContaining({
        OPENWIKI_NOTION_MCP_ACCESS_TOKEN: "notion-access",
        OPENWIKI_NOTION_MCP_CLIENT_ID: "notion-client-123",
        OPENWIKI_NOTION_MCP_REFRESH_TOKEN: "notion-refresh",
      }),
    );
    expect(result).toMatchObject({ provider: "notion" });
  });

  test("rejects a callback whose state does not match the started flow", async () => {
    process.env[GOOGLE_CLIENT_ID_ENV_KEY] = "gmail-client";
    process.env[GOOGLE_CLIENT_SECRET_ENV_KEY] = "gmail-secret";
    installFetchRouter({
      tokenPayload: { access_token: "unused" },
    });

    const { runPromise, urlReady } = startRun("gmail");
    await urlReady;

    // A forged state is the CSRF signal: the redirect did not originate from the
    // authorization request this process started, so no token exchange runs.
    const rejection = expect(runPromise).rejects.toThrow(
      "OAuth callback state did not match.",
    );
    await driveCallback("attacker-state", "gmail-auth-code");
    await rejection;
  });

  test("surfaces a failed token exchange", async () => {
    process.env[GOOGLE_CLIENT_ID_ENV_KEY] = "gmail-client";
    process.env[GOOGLE_CLIENT_SECRET_ENV_KEY] = "gmail-secret";
    installFetchRouter({ tokenStatus: 500 });

    const { runPromise, urlReady } = startRun("gmail");
    const event = await urlReady;
    const state = new URL(event.url).searchParams.get("state") as string;

    // Attach the rejection expectation before driving the redirect so the
    // failure the token exchange raises is never momentarily unhandled.
    const rejection = expect(runPromise).rejects.toThrow(
      "Gmail token exchange failed: 500",
    );
    await driveCallback(state, "gmail-auth-code");
    await rejection;
    expect(saveOpenWikiEnvMock).not.toHaveBeenCalled();
  });

  test("rejects a token response that omits the access token", async () => {
    process.env[GOOGLE_CLIENT_ID_ENV_KEY] = "gmail-client";
    process.env[GOOGLE_CLIENT_SECRET_ENV_KEY] = "gmail-secret";
    installFetchRouter({ tokenPayload: { refresh_token: "only-refresh" } });

    const { runPromise, urlReady } = startRun("gmail");
    const event = await urlReady;
    const state = new URL(event.url).searchParams.get("state") as string;

    // Attach the rejection expectation before driving the redirect so the
    // mapping failure is never momentarily unhandled.
    const rejection = expect(runPromise).rejects.toThrow(
      "Gmail did not return an access token.",
    );
    await driveCallback(state, "gmail-auth-code");
    await rejection;
    expect(saveOpenWikiEnvMock).not.toHaveBeenCalled();
  });

  test("requires the Gmail client id before any browser is opened", async () => {
    // Missing OPENWIKI_GOOGLE_CLIENT_ID fails inside resolveClientRegistration,
    // before an authorization URL exists, so the flow never spawns a browser.
    delete process.env[GOOGLE_CLIENT_ID_ENV_KEY];
    delete process.env[GOOGLE_CLIENT_SECRET_ENV_KEY];
    installFetchRouter();

    await expect(runOAuthAuth("gmail", { silent: true })).rejects.toThrow(
      "OPENWIKI_GOOGLE_CLIENT_ID is required for auth.",
    );
    expect(execFileMock).not.toHaveBeenCalled();
    expect(saveOpenWikiEnvMock).not.toHaveBeenCalled();
  });

  test("fails when dynamic client registration is rejected", async () => {
    installFetchRouter({ registrationStatus: 400 });

    await expect(runOAuthAuth("notion", { silent: true })).rejects.toThrow(
      "Notion MCP dynamic client registration failed: 400",
    );
    expect(saveOpenWikiEnvMock).not.toHaveBeenCalled();
  });

  test("fails when dynamic registration returns no client id", async () => {
    installFetchRouter({ registrationNoClientId: true });

    await expect(runOAuthAuth("notion", { silent: true })).rejects.toThrow(
      "Notion MCP dynamic client registration did not return a client_id.",
    );
    expect(saveOpenWikiEnvMock).not.toHaveBeenCalled();
  });

  test("requires the Gmail client secret for a confidential client", async () => {
    // Gmail authenticates the token call with client_secret_post, so a present
    // client id but missing secret must fail before any browser is opened.
    process.env[GOOGLE_CLIENT_ID_ENV_KEY] = "gmail-client";
    delete process.env[GOOGLE_CLIENT_SECRET_ENV_KEY];
    installFetchRouter();

    await expect(runOAuthAuth("gmail", { silent: true })).rejects.toThrow(
      "OPENWIKI_GOOGLE_CLIENT_SECRET is required for auth.",
    );
    expect(execFileMock).not.toHaveBeenCalled();
    expect(saveOpenWikiEnvMock).not.toHaveBeenCalled();
  });

  test("fails when the MCP resource advertises no authorization server", async () => {
    // An empty protected-resource document means there is no issuer to register
    // with, so the flow stops rather than guessing an endpoint.
    const fetchMock = vi.fn((input: string | URL) => {
      const url = typeof input === "string" ? input : input.href;
      if (url.includes(".well-known/oauth-protected-resource")) {
        return jsonResponse({});
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(runOAuthAuth("notion", { silent: true })).rejects.toThrow(
      "Notion MCP did not advertise an authorization server.",
    );
  });

  test("fails when OAuth discovery omits a required endpoint", async () => {
    // Registration cannot proceed without all three endpoints; a metadata
    // document missing the registration endpoint is rejected.
    const fetchMock = vi.fn((input: string | URL) => {
      const url = typeof input === "string" ? input : input.href;
      if (url.includes(".well-known/oauth-protected-resource")) {
        return jsonResponse({
          authorization_servers: ["https://mcp.notion.com"],
        });
      }
      if (url.includes(".well-known/oauth-authorization-server")) {
        return jsonResponse({
          authorization_endpoint: NOTION_AUTH_ENDPOINT,
          token_endpoint: NOTION_TOKEN_ENDPOINT,
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(runOAuthAuth("notion", { silent: true })).rejects.toThrow(
      "Notion MCP OAuth discovery did not return required endpoints.",
    );
  });

  test("completes the flow even when the browser launcher fails", async () => {
    process.env[GOOGLE_CLIENT_ID_ENV_KEY] = "gmail-client";
    process.env[GOOGLE_CLIENT_SECRET_ENV_KEY] = "gmail-secret";
    installFetchRouter({ tokenPayload: { access_token: "gmail-access" } });

    // A launcher that errors (no `open`/`xdg-open`, no `pbcopy`) must degrade to
    // printing the URL, not abort the authorization: openBrowser and
    // copyToClipboard swallow the failure and report false.
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        callback: (error: Error | null) => void,
      ) => {
        queueMicrotask(() => callback(new Error("launcher missing")));
        return { stdin: { end: vi.fn() } };
      },
    );

    const { runPromise, urlReady } = startRun("gmail");
    const event = await urlReady;
    const state = new URL(event.url).searchParams.get("state") as string;

    expect(event.openedBrowser).toBe(false);
    expect(event.copiedToClipboard).toBe(false);

    await driveCallback(state, "gmail-auth-code");
    await runPromise;
    expect(saveOpenWikiEnvMock).toHaveBeenCalledTimes(1);
  });

  test("uses the win32 file-protocol handler to open the browser", async () => {
    process.env[GOOGLE_CLIENT_ID_ENV_KEY] = "gmail-client";
    process.env[GOOGLE_CLIENT_SECRET_ENV_KEY] = "gmail-secret";
    installFetchRouter({ tokenPayload: { access_token: "gmail-access" } });

    // Exercise the Windows dispatch branch on any host by faking the platform;
    // restored in finally so it cannot bleed into another test.
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });

    try {
      const { runPromise, urlReady } = startRun("gmail");
      const event = await urlReady;
      const state = new URL(event.url).searchParams.get("state") as string;

      // rundll32 receives the URL as a verbatim argv element (no shell), and
      // clipboard copy is macOS-only so it reports false here.
      expect(event.openedBrowser).toBe(true);
      expect(event.copiedToClipboard).toBe(false);
      const browserCall = execFileMock.mock.calls.find(
        (call) => call[0] === "rundll32",
      );
      expect(browserCall?.[1]).toEqual([
        "url.dll,FileProtocolHandler",
        event.url,
      ]);

      await driveCallback(state, "gmail-auth-code");
      await runPromise;
    } finally {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  test("uses xdg-open to open the browser on linux", async () => {
    process.env[GOOGLE_CLIENT_ID_ENV_KEY] = "gmail-client";
    process.env[GOOGLE_CLIENT_SECRET_ENV_KEY] = "gmail-secret";
    installFetchRouter({ tokenPayload: { access_token: "gmail-access" } });

    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "linux",
    });

    try {
      const { runPromise, urlReady } = startRun("gmail");
      const event = await urlReady;
      const state = new URL(event.url).searchParams.get("state") as string;

      expect(event.openedBrowser).toBe(true);
      expect(event.copiedToClipboard).toBe(false);
      const browserCall = execFileMock.mock.calls.find(
        (call) => call[0] === "xdg-open",
      );
      expect(browserCall?.[1]).toEqual([event.url]);

      await driveCallback(state, "gmail-auth-code");
      await runPromise;
    } finally {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
  });
});
