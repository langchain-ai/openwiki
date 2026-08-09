import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import {
  XAI_GROK_ACCESS_TOKEN_ENV_KEY,
  XAI_GROK_EXPIRES_AT_ENV_KEY,
  XAI_GROK_REFRESH_TOKEN_ENV_KEY,
} from "../config/constants.js";
import { saveOpenWikiEnv } from "../config/env.js";

/**
 * xAI Grok subscription OAuth client.
 *
 * Uses the public Grok CLI OAuth client (no secret; PKCE) against auth.x.ai and
 * the OpenAI-compatible chat API at api.x.ai. This is unofficial relative to a
 * dedicated OpenWiki app registration — client id, scopes, or endpoints may
 * change. Keep constants centralized here.
 */

/** Public Grok CLI OAuth client id (no client secret; PKCE public client). */
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_SCOPE =
  "openid profile email offline_access grok-cli:access api:access";
const XAI_ISSUER = "https://auth.x.ai";
const XAI_AUTHORIZE_URL = `${XAI_ISSUER}/oauth2/authorize`;
const XAI_TOKEN_URL = `${XAI_ISSUER}/oauth2/token`;
const XAI_REFERRER = "openwiki";

/** Dedicated loopback port so ChatGPT (1455) and connector OAuth (53682) stay free. */
const DEFAULT_CALLBACK_PORT = 1456;
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
const OAUTH_CALLBACK_PORT_ENV_KEY = "OPENWIKI_OAUTH_CALLBACK_PORT";

/** OpenAI-compatible chat base URL; LangChain appends `/chat/completions`. */
export const XAI_API_BASE_URL = "https://api.x.ai/v1";

/**
 * Refresh the access token when it is within this many milliseconds of expiry,
 * so a token does not lapse mid-run.
 */
export const XAI_GROK_TOKEN_REFRESH_THRESHOLD_MS = 60_000;

export const XAI_GROK_LOGIN_INCOMPLETE_MESSAGE =
  "xAI Grok login is incomplete. Run `openwiki --init` to sign in with your xAI account.";

export interface XaiGrokTokens {
  access: string;
  refresh: string;
  /** Absolute expiry time of the access token, in epoch milliseconds. */
  expiresAtMs: number;
}

export interface XaiGrokLoginHandle {
  /**
   * Complete the login from a manually pasted value — either the full redirect
   * URL the browser landed on or the bare `code`. Returns `null` on success, or
   * a human-readable error string if the input can't be used.
   */
  submitManual(input: string): string | null;
}

/**
 * The single source of truth for how {@link XaiGrokTokens} maps onto the
 * `~/.openwiki/.env` keys.
 */
export function xaiGrokTokensToEnv(
  tokens: XaiGrokTokens,
): Record<string, string> {
  return {
    [XAI_GROK_ACCESS_TOKEN_ENV_KEY]: tokens.access,
    [XAI_GROK_REFRESH_TOKEN_ENV_KEY]: tokens.refresh,
    [XAI_GROK_EXPIRES_AT_ENV_KEY]: String(tokens.expiresAtMs),
  };
}

/**
 * Reads persisted {@link XaiGrokTokens} back out of the environment. Returns
 * `null` unless access + refresh tokens are both present.
 */
export function readXaiGrokTokensFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): XaiGrokTokens | null {
  const access = env[XAI_GROK_ACCESS_TOKEN_ENV_KEY];
  const refresh = env[XAI_GROK_REFRESH_TOKEN_ENV_KEY];

  if (!access || !refresh) {
    return null;
  }

  return {
    access,
    refresh,
    expiresAtMs: Number(env[XAI_GROK_EXPIRES_AT_ENV_KEY]),
  };
}

/** Completeness + near-expiry check for wizard / startup. */
export function hasValidXaiGrokTokens(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const tokens = readXaiGrokTokensFromEnv(env);

  return tokens !== null && !isXaiGrokTokenExpired(tokens.expiresAtMs);
}

/**
 * Whether a token expiring at `expiresAtMs` should be refreshed now, accounting
 * for the near-expiry threshold.
 */
export function isXaiGrokTokenExpired(
  expiresAtMs: number,
  now = Date.now(),
  thresholdMs = XAI_GROK_TOKEN_REFRESH_THRESHOLD_MS,
): boolean {
  return !Number.isFinite(expiresAtMs) || now >= expiresAtMs - thresholdMs;
}

/**
 * Extracts the `code`/`state` from a manually pasted value. Accepts a full
 * redirect URL, a bare query string (`code=…&state=…`), or a bare code.
 */
export function parseManualCallbackInput(input: string): {
  code: string | null;
  state: string | null;
} {
  const trimmed = input.trim();

  if (/^https?:\/\//iu.test(trimmed)) {
    try {
      const url = new URL(trimmed);

      return {
        code: url.searchParams.get("code"),
        state: url.searchParams.get("state"),
      };
    } catch {
      return { code: null, state: null };
    }
  }

  if (trimmed.includes("code=")) {
    const params = new URLSearchParams(
      trimmed.startsWith("?") ? trimmed.slice(1) : trimmed,
    );

    return { code: params.get("code"), state: params.get("state") };
  }

  return { code: trimmed.length > 0 ? trimmed : null, state: null };
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());

  return { verifier, challenge };
}

function getCallbackPort(): number {
  const rawPort = process.env[OAUTH_CALLBACK_PORT_ENV_KEY];

  if (!rawPort) {
    return DEFAULT_CALLBACK_PORT;
  }

  if (!/^[0-9]{1,5}$/u.test(rawPort)) {
    throw new Error(`${OAUTH_CALLBACK_PORT_ENV_KEY} must be a TCP port.`);
  }

  const port = Number(rawPort);

  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(
      `${OAUTH_CALLBACK_PORT_ENV_KEY} must be between 1024 and 65535.`,
    );
  }

  return port;
}

type TokenJson = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

async function parseTokenResponse(
  res: Response,
  previousRefresh?: string,
): Promise<XaiGrokTokens> {
  let json: TokenJson;

  try {
    json = (await res.json()) as TokenJson;
  } catch {
    throw new Error(
      `xAI token request failed (${res.status}). Try signing in again.`,
    );
  }

  if (!res.ok) {
    const detail = json.error_description ?? json.error;

    if (json.error === "invalid_grant") {
      throw new Error(
        "xAI session expired or was revoked. Sign in again with `openwiki --init`.",
      );
    }

    throw new Error(
      detail
        ? `xAI token request failed (${res.status}): ${detail}`
        : `xAI token request failed (${res.status}). Try signing in again.`,
    );
  }

  if (!json.access_token) {
    throw new Error(
      "xAI token response missing required fields: access_token.",
    );
  }

  const refresh = json.refresh_token ?? previousRefresh;

  if (!refresh) {
    throw new Error(
      "xAI token response missing required fields: refresh_token.",
    );
  }

  if (json.expires_in === undefined || json.expires_in === null) {
    throw new Error("xAI token response missing required fields: expires_in.");
  }

  return {
    access: json.access_token,
    refresh,
    expiresAtMs: Date.now() + Number(json.expires_in) * 1000,
  };
}

async function exchangeAuthorizationCode(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<XaiGrokTokens> {
  const res = await fetch(XAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: XAI_OAUTH_CLIENT_ID,
      code: params.code,
      code_verifier: params.codeVerifier,
      redirect_uri: params.redirectUri,
    }),
  });

  return parseTokenResponse(res);
}

/**
 * Exchanges a refresh token for a fresh access token. xAI may rotate the
 * refresh token, so callers must persist whatever `refresh` comes back.
 */
export async function refreshXaiGrokTokens(
  refreshToken: string,
): Promise<XaiGrokTokens> {
  const res = await fetch(XAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: XAI_OAUTH_CLIENT_ID,
    }),
  });

  return parseTokenResponse(res, refreshToken);
}

let refreshInFlight: Promise<XaiGrokTokens> | null = null;

/**
 * Refreshes persisted xAI tokens when near expiry, writing rotated tokens back
 * to `~/.openwiki/.env` (and `process.env`). Single-flight so concurrent callers
 * share one refresh.
 */
export async function ensureFreshXaiGrokTokens(): Promise<XaiGrokTokens> {
  const tokens = readXaiGrokTokensFromEnv();

  if (!tokens) {
    throw new Error(XAI_GROK_LOGIN_INCOMPLETE_MESSAGE);
  }

  if (!isXaiGrokTokenExpired(tokens.expiresAtMs)) {
    return tokens;
  }

  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const refreshed = await refreshXaiGrokTokens(tokens.refresh);
      await saveOpenWikiEnv(xaiGrokTokensToEnv(refreshed));

      return refreshed;
    })().finally(() => {
      refreshInFlight = null;
    });
  }

  return refreshInFlight;
}

const LOGIN_SUCCESS_HTML =
  "<!DOCTYPE html><html><head><meta charset=\"utf-8\"/>" +
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\"/>" +
  "<title>OpenWiki</title></head><body style=\"font-family:system-ui;padding:2rem\">" +
  "<p>OpenWiki xAI login complete. You can close this tab.</p></body></html>";

/**
 * Runs the browser Authorization Code + PKCE login. `openUrl` is invoked once
 * the local callback server is listening. When loopback cannot receive the
 * redirect, paste the callback URL or code via {@link XaiGrokLoginHandle}.
 */
export async function loginWithXaiGrok(
  openUrl: (url: string) => void,
  onReady?: (handle: XaiGrokLoginHandle) => void,
): Promise<XaiGrokTokens> {
  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString("hex");
  const callbackPort = getCallbackPort();
  const redirectUri = `http://${CALLBACK_HOST}:${callbackPort}${CALLBACK_PATH}`;

  const authUrl = new URL(XAI_AUTHORIZE_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", XAI_OAUTH_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", XAI_OAUTH_SCOPE);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("referrer", XAI_REFERRER);
  // Grok CLI commonly sends plan=generic; keep unless xAI rejects it.
  authUrl.searchParams.set("plan", "generic");

  const code = await new Promise<string>((resolve, reject) => {
    let settled = false;

    const finish = (authCode: string): void => {
      if (settled) {
        return;
      }

      settled = true;
      server.close();
      resolve(authCode);
    };

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      server.close();
      reject(error);
    };

    const server = http.createServer((req, res) => {
      const url = new URL(
        req.url ?? "",
        `http://${CALLBACK_HOST}:${callbackPort}`,
      );

      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }

      // Bad requests don't abort the login — the manual-paste path may still
      // complete it — so respond with an error but keep waiting.
      if (url.searchParams.get("state") !== state) {
        res.writeHead(400).end("State mismatch");
        return;
      }

      const authCode = url.searchParams.get("code");

      if (!authCode) {
        res.writeHead(400).end("Missing authorization code");
        return;
      }

      res
        .writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy":
            "default-src 'none'; style-src 'unsafe-inline'",
        })
        .end(LOGIN_SUCCESS_HTML);
      finish(authCode);
    });

    // Loopback only: never bind an unauthenticated code-capture endpoint to a
    // public interface.
    server.listen(callbackPort, CALLBACK_HOST, () => {
      openUrl(authUrl.toString());
      onReady?.({
        submitManual(rawInput) {
          const { code: manualCode, state: manualState } =
            parseManualCallbackInput(rawInput);

          if (!manualCode) {
            return "Could not find an authorization code in that input.";
          }

          if (manualState !== null && manualState !== state) {
            return "State mismatch — paste the URL from this login attempt.";
          }

          finish(manualCode);
          return null;
        },
      });
    });
    server.on("error", fail);
  });

  return exchangeAuthorizationCode({
    code,
    codeVerifier: verifier,
    redirectUri,
  });
}
