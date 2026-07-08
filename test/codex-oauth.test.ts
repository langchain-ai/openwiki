import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CODEX_BACKEND_BASE_URL,
  CODEX_OAUTH_AUTHORIZE_URL,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_REDIRECT_URI,
  CODEX_OAUTH_TOKEN_URL,
  CodexChatOpenAI,
  completeCodexOAuthLogin,
  createSyntheticJwt,
  parseCodexOAuthCallbackUrl,
  resolveCodexOAuthCredentials,
  startCodexOAuthLogin,
} from "../src/codex-oauth.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("startCodexOAuthLogin", () => {
  test("generates a PKCE authorize URL and persists the pending verifier with 0600 permissions", async () => {
    const now = new Date("2026-07-08T12:00:00.000Z");
    const authPath = await createAuthPath();
    const verifierBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
    const stateBytes = Buffer.from(Array.from({ length: 24 }, (_, index) => 255 - index));
    const randomBytes = vi.fn((size: number) => {
      if (size === 32) {
        return verifierBytes;
      }

      if (size === 24) {
        return stateBytes;
      }

      throw new Error(`unexpected random byte request: ${size}`);
    });

    const { authorizeUrl, state } = await startCodexOAuthLogin({
      authPath,
      now,
      randomBytes,
    });

    const expectedCodeVerifier = verifierBytes.toString("base64url");
    const expectedState = stateBytes.toString("base64url");
    const expectedCodeChallenge = createHash("sha256")
      .update(expectedCodeVerifier)
      .digest("base64url");
    const saved = await readAuthFile(authPath);
    const parsed = new URL(authorizeUrl);

    expect(state).toBe(expectedState);
    expect(randomBytes).toHaveBeenCalledTimes(2);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(CODEX_OAUTH_AUTHORIZE_URL);
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe(CODEX_OAUTH_CLIENT_ID);
    expect(parsed.searchParams.get("redirect_uri")).toBe(CODEX_OAUTH_REDIRECT_URI);
    expect(parsed.searchParams.get("scope")).toBe("openid profile email offline_access");
    expect(parsed.searchParams.get("code_challenge")).toBe(expectedCodeChallenge);
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("state")).toBe(expectedState);
    expect(parsed.searchParams.get("originator")).toBe("openwiki");
    expect(saved).toEqual({
      pending: {
        codeVerifier: expectedCodeVerifier,
        createdAt: now.toISOString(),
        redirectUri: CODEX_OAUTH_REDIRECT_URI,
        state: expectedState,
      },
      updatedAt: now.toISOString(),
    });
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
  });
});

describe("parseCodexOAuthCallbackUrl", () => {
  test("parses a pasted callback URL after trimming surrounding whitespace", () => {
    expect(
      parseCodexOAuthCallbackUrl(
        "  https://callback.example.invalid/oauth?code=synthetic-code&state=state-123  ",
      ),
    ).toEqual({
      code: "synthetic-code",
      state: "state-123",
    });
  });

  test("requires both code and state parameters in the callback URL", () => {
    expect(() =>
      parseCodexOAuthCallbackUrl("https://callback.example.invalid/oauth?code=only-code"),
    ).toThrow("Codex OAuth callback URL must include code and state parameters.");
  });
});

describe("completeCodexOAuthLogin", () => {
  test("rejects a callback whose state does not match the pending login", async () => {
    const authPath = await createAuthPath();
    const fetchMock = vi.fn<typeof fetch>();

    await writeAuthFile(authPath, {
      pending: {
        codeVerifier: "verifier-123",
        createdAt: "2026-07-08T12:00:00.000Z",
        redirectUri: CODEX_OAUTH_REDIRECT_URI,
        state: "expected-state",
      },
      updatedAt: "2026-07-08T12:00:00.000Z",
    });

    await expect(
      completeCodexOAuthLogin(
        "https://callback.example.invalid/oauth?code=synthetic-code&state=wrong-state",
        {
          authPath,
          fetch: fetchMock,
        },
      ),
    ).rejects.toThrow("Codex OAuth callback state did not match the pending login.");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readAuthFile(authPath)).toEqual({
      pending: {
        codeVerifier: "verifier-123",
        createdAt: "2026-07-08T12:00:00.000Z",
        redirectUri: CODEX_OAUTH_REDIRECT_URI,
        state: "expected-state",
      },
      updatedAt: "2026-07-08T12:00:00.000Z",
    });
  });

  test("exchanges the callback code, extracts the account id from the id_token, and persists the token set with 0600 permissions", async () => {
    const now = new Date("2026-07-08T13:00:00.000Z");
    const authPath = await createAuthPath();
    const idToken = createSyntheticJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_test_123",
        chatgpt_plan_type: "pro",
      },
    });
    const captured = {
      body: new URLSearchParams(),
      headers: {} as Record<string, string>,
      method: "",
      url: "",
    };
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      captured.url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      captured.method = init?.method ?? "";
      captured.headers = (init?.headers ?? {}) as Record<string, string>;
      if (init?.body instanceof URLSearchParams) {
        captured.body = init.body;
      } else if (typeof init?.body === "string") {
        captured.body = new URLSearchParams(init.body);
      } else {
        captured.body = new URLSearchParams();
      }

      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "access-token-1",
            expires_in: 3600,
            id_token: idToken,
            refresh_token: "refresh-token-1",
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        ),
      );
    });

    await writeAuthFile(authPath, {
      pending: {
        codeVerifier: "verifier-xyz",
        createdAt: "2026-07-08T12:55:00.000Z",
        redirectUri: CODEX_OAUTH_REDIRECT_URI,
        state: "state-xyz",
      },
      updatedAt: "2026-07-08T12:55:00.000Z",
    });

    await expect(
      completeCodexOAuthLogin(
        "https://callback.example.invalid/oauth?code=synthetic-code&state=state-xyz",
        {
          authPath,
          fetch: fetchMock,
          now,
        },
      ),
    ).resolves.toEqual({
      accessToken: "access-token-1",
      accountId: "acct_test_123",
    });

    expect(captured.url).toBe(CODEX_OAUTH_TOKEN_URL);
    expect(captured.method).toBe("POST");
    expect(captured.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(captured.body.get("client_id")).toBe(CODEX_OAUTH_CLIENT_ID);
    expect(captured.body.get("code")).toBe("synthetic-code");
    expect(captured.body.get("code_verifier")).toBe("verifier-xyz");
    expect(captured.body.get("grant_type")).toBe("authorization_code");
    expect(captured.body.get("redirect_uri")).toBe(CODEX_OAUTH_REDIRECT_URI);
    expect(await readAuthFile(authPath)).toEqual({
      tokens: {
        accessToken: "access-token-1",
        accountId: "acct_test_123",
        expiresAt: "2026-07-08T14:00:00.000Z",
        idToken,
        planType: "pro",
        refreshToken: "refresh-token-1",
      },
      updatedAt: now.toISOString(),
    });
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
  });
});

describe("resolveCodexOAuthCredentials", () => {
  test("keeps the persisted token when expiry is still just outside the refresh window", async () => {
    const now = new Date("2026-07-08T12:00:00.000Z");
    const authPath = await createAuthPath();
    const idToken = createSyntheticJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_test_123",
      },
    });
    const fetchMock = vi.fn<typeof fetch>();

    await writeAuthFile(authPath, {
      tokens: {
        accessToken: "cached-access-token",
        accountId: "acct_test_123",
        expiresAt: "2026-07-08T12:05:01.000Z",
        idToken,
        planType: null,
        refreshToken: "cached-refresh-token",
      },
      updatedAt: "2026-07-08T11:59:00.000Z",
    });

    await expect(
      resolveCodexOAuthCredentials({
        authPath,
        fetch: fetchMock,
        now,
      }),
    ).resolves.toEqual({
      accessToken: "cached-access-token",
      accountId: "acct_test_123",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readAuthFile(authPath)).toEqual({
      tokens: {
        accessToken: "cached-access-token",
        accountId: "acct_test_123",
        expiresAt: "2026-07-08T12:05:01.000Z",
        idToken,
        planType: null,
        refreshToken: "cached-refresh-token",
      },
      updatedAt: "2026-07-08T11:59:00.000Z",
    });
  });

  test("refreshes tokens exactly at the near-expiry boundary and persists a rotated refresh token", async () => {
    const now = new Date("2026-07-08T12:00:00.000Z");
    const authPath = await createAuthPath();
    const idToken = createSyntheticJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_test_123",
        chatgpt_plan_type: "plus",
      },
    });
    let capturedBody = "";
    let capturedMethod = "";
    let capturedUrl = "";
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      capturedUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      capturedMethod = init?.method ?? "";
      capturedBody = typeof init?.body === "string" ? init.body : "";

      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "refreshed-access-token",
            expires_in: 7200,
            refresh_token: "rotated-refresh-token",
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        ),
      );
    });

    await writeAuthFile(authPath, {
      tokens: {
        accessToken: "stale-access-token",
        accountId: "acct_test_123",
        expiresAt: "2026-07-08T12:05:00.000Z",
        idToken,
        planType: "plus",
        refreshToken: "stale-refresh-token",
      },
      updatedAt: "2026-07-08T11:00:00.000Z",
    });

    await expect(
      resolveCodexOAuthCredentials({
        authPath,
        fetch: fetchMock,
        now,
      }),
    ).resolves.toEqual({
      accessToken: "refreshed-access-token",
      accountId: "acct_test_123",
    });

    expect(capturedUrl).toBe(CODEX_OAUTH_TOKEN_URL);
    expect(capturedMethod).toBe("POST");
    expect(JSON.parse(capturedBody)).toEqual({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: "stale-refresh-token",
    });
    expect(await readAuthFile(authPath)).toEqual({
      tokens: {
        accessToken: "refreshed-access-token",
        accountId: "acct_test_123",
        expiresAt: "2026-07-08T14:00:00.000Z",
        idToken,
        planType: "plus",
        refreshToken: "rotated-refresh-token",
      },
      updatedAt: now.toISOString(),
    });
  });
});

describe("CodexChatOpenAI", () => {
  test("routes requests to the Codex backend responses API and lifts system messages into instructions", async () => {
    let capturedBody = "";
    let capturedUrl = "";
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      capturedUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      capturedBody = typeof init?.body === "string" ? init.body : "";

      return Promise.resolve(
        new Response("{\"error\":\"stop\"}", {
          headers: { "content-type": "application/json" },
          status: 400,
        }),
      );
    });
    const model = new CodexChatOpenAI({
      codexCredentials: {
        accessToken: "access-token-1",
        accountId: "acct_test_123",
      },
      configuration: { fetch: fetchMock },
      model: "gpt-5.5",
    });

    await expect(async () => {
      for await (const event of model.streamEvents(
        [
          new SystemMessage("system instructions"),
          new SystemMessage("developer guardrails"),
          new HumanMessage("hello"),
        ],
        { version: "v2" },
      )) {
        expect(event).toBeDefined();
      }
    }).rejects.toThrow();

    expect(capturedUrl).toBe(`${CODEX_BACKEND_BASE_URL}/responses`);
    const payload = JSON.parse(capturedBody) as {
      input: Array<{ role?: string }>;
      instructions?: string;
    };
    expect(payload.instructions).toBe("system instructions\n\ndeveloper guardrails");
    expect(payload.input.map((item) => item.role)).toEqual(["user"]);
  });
});

type SavedCodexAuth = {
  pending?: {
    codeVerifier?: string;
    createdAt?: string;
    redirectUri?: string;
    state?: string;
  };
  tokens?: Record<string, unknown>;
  updatedAt?: string;
};

async function createAuthPath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openwiki-codex-oauth-"));
  tempDirs.push(dir);
  const authPath = path.join(dir, ".openwiki", "codex-oauth.json");

  return authPath;
}

async function readAuthFile(authPath: string): Promise<SavedCodexAuth> {
  const raw = await readFile(authPath, "utf8");
  const parsed: unknown = JSON.parse(raw);

  return parsed as SavedCodexAuth;
}

async function writeAuthFile(
  authPath: string,
  authFile: SavedCodexAuth,
): Promise<void> {
  await mkdir(path.dirname(authPath), { recursive: true });
  await writeFile(authPath, `${JSON.stringify(authFile, null, 2)}\n`, "utf8");
}
