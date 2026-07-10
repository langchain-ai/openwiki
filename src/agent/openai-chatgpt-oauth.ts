import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import {
  OPENAI_CHATGPT_ACCESS_TOKEN_ENV_KEY,
  OPENAI_CHATGPT_ACCOUNT_ID_ENV_KEY,
  OPENAI_CHATGPT_EMAIL_ENV_KEY,
  OPENAI_CHATGPT_EXPIRES_AT_ENV_KEY,
  OPENAI_CHATGPT_PLAN_ENV_KEY,
  OPENAI_CHATGPT_REFRESH_TOKEN_ENV_KEY,
} from "../constants.js";

/**
 * ChatGPT/Codex OAuth client.
 *
 * Ports the PKCE login + token refresh flow OpenAI's own Codex CLI uses so that
 * OpenWiki can authenticate model calls against the Codex backend
 * (`https://chatgpt.com/backend-api/codex`) with a ChatGPT subscription instead
 * of a metered API key. See docs/reference under codex-oauth-docs for the
 * protocol this implements.
 */

/** OpenAI's first-party Codex CLI client id — not a self-serve, registerable id. */
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CALLBACK_PORT = 1455;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`;
const SCOPE = "openid profile email offline_access";

/** Base URL for the Codex Responses backend; the OpenAI SDK appends `/responses`. */
export const CODEX_RESPONSES_BASE_URL = "https://chatgpt.com/backend-api/codex";

/** Free-text client label sent as the `originator` header/param. */
export const CODEX_ORIGINATOR = "openwiki";

/**
 * Refresh the access token when it is within this many milliseconds of expiry,
 * so a token does not lapse mid-run.
 */
export const CHATGPT_TOKEN_REFRESH_THRESHOLD_MS = 60_000;

export interface CodexTokens {
  access: string;
  refresh: string;
  /** Absolute expiry time of the access token, in epoch milliseconds. */
  expiresAtMs: number;
  accountId: string;
  /** Signed-in account email, decoded from the token (best-effort). */
  email: string | null;
  /** ChatGPT plan (e.g. `plus`, `pro`, `team`), decoded from the token. */
  planType: string | null;
}

export interface ChatGptIdentity {
  accountId: string | null;
  email: string | null;
  planType: string | null;
}

/**
 * The single source of truth for how {@link CodexTokens} maps onto the
 * `~/.openwiki/.env` keys. Both the credential wizard and the agent's
 * refresh-at-startup write tokens through this, so the env contract lives next
 * to the type it serializes.
 */
export function codexTokensToEnv(tokens: CodexTokens): Record<string, string> {
  return {
    [OPENAI_CHATGPT_ACCESS_TOKEN_ENV_KEY]: tokens.access,
    [OPENAI_CHATGPT_REFRESH_TOKEN_ENV_KEY]: tokens.refresh,
    [OPENAI_CHATGPT_EXPIRES_AT_ENV_KEY]: String(tokens.expiresAtMs),
    [OPENAI_CHATGPT_ACCOUNT_ID_ENV_KEY]: tokens.accountId,
    ...(tokens.email ? { [OPENAI_CHATGPT_EMAIL_ENV_KEY]: tokens.email } : {}),
    ...(tokens.planType
      ? { [OPENAI_CHATGPT_PLAN_ENV_KEY]: tokens.planType }
      : {}),
  };
}

/**
 * Reads persisted {@link CodexTokens} back out of the environment. Returns
 * `null` unless the three fields required to call the Codex backend (access
 * token, refresh token, account id) are all present.
 */
export function readCodexTokensFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CodexTokens | null {
  const access = env[OPENAI_CHATGPT_ACCESS_TOKEN_ENV_KEY];
  const refresh = env[OPENAI_CHATGPT_REFRESH_TOKEN_ENV_KEY];
  const accountId = env[OPENAI_CHATGPT_ACCOUNT_ID_ENV_KEY];

  if (!access || !refresh || !accountId) {
    return null;
  }

  return {
    access,
    refresh,
    accountId,
    expiresAtMs: Number(env[OPENAI_CHATGPT_EXPIRES_AT_ENV_KEY]),
    email: env[OPENAI_CHATGPT_EMAIL_ENV_KEY] ?? null,
    planType: env[OPENAI_CHATGPT_PLAN_ENV_KEY] ?? null,
  };
}

/** Formats an `email (Plan)` label from decoded ChatGPT identity claims. */
export function formatChatGptAccount(
  email: string | null,
  planType: string | null,
): string | null {
  const plan = planType
    ? planType.charAt(0).toUpperCase() + planType.slice(1)
    : null;

  if (email && plan) {
    return `${email} (${plan})`;
  }

  return email ?? plan ?? null;
}

/** {@link formatChatGptAccount} for the identity persisted in the environment. */
export function formatChatGptAccountFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return formatChatGptAccount(
    env[OPENAI_CHATGPT_EMAIL_ENV_KEY] ?? null,
    env[OPENAI_CHATGPT_PLAN_ENV_KEY] ?? null,
  );
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

/**
 * Decodes identity claims from the access-token JWT: the mandatory
 * `chatgpt_account_id` (required for the Codex request header) plus the
 * best-effort `chatgpt_plan_type` and profile `email` used only for display.
 * No signature verification: these are our own credentials, read for our own
 * bookkeeping.
 */
export function decodeChatGptIdentity(accessToken: string): ChatGptIdentity {
  const empty: ChatGptIdentity = {
    accountId: null,
    email: null,
    planType: null,
  };
  const parts = accessToken.split(".");

  if (parts.length !== 3) {
    return empty;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as Record<string, unknown>;

    const auth = asRecord(payload["https://api.openai.com/auth"]);
    const profile = asRecord(payload["https://api.openai.com/profile"]);

    return {
      accountId: asString(auth?.chatgpt_account_id),
      email: asString(profile?.email),
      planType: asString(auth?.chatgpt_plan_type),
    };
  } catch {
    return empty;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function exchangeToken(body: URLSearchParams): Promise<CodexTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    throw new Error(
      `ChatGPT token request failed (${res.status}). Try signing in again.`,
    );
  }

  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const missing = (
    ["access_token", "refresh_token", "expires_in"] as const
  ).filter((field) => json[field] === undefined || json[field] === null);

  if (missing.length > 0) {
    throw new Error(
      `ChatGPT token response missing required fields: ${missing.join(", ")}.`,
    );
  }

  const access = json.access_token as string;
  const identity = decodeChatGptIdentity(access);

  if (!identity.accountId) {
    throw new Error("Failed to extract account id from ChatGPT access token.");
  }

  return {
    access,
    refresh: json.refresh_token as string,
    expiresAtMs: Date.now() + (json.expires_in as number) * 1000,
    accountId: identity.accountId,
    email: identity.email,
    planType: identity.planType,
  };
}

/**
 * Runs the browser Authorization Code + PKCE login. `openUrl` is invoked once
 * the local callback server is listening: open a browser tab and/or print the
 * URL for headless use. Resolves with the exchanged tokens.
 */
export interface ChatGptLoginHandle {
  /**
   * Complete the login from a manually pasted value — either the full redirect
   * URL the browser landed on (`http://localhost:1455/auth/callback?code=…`) or
   * the bare `code`. Returns `null` on success, or a human-readable error string
   * if the input can't be used (so it can be shown inline without aborting).
   */
  submitManual(input: string): string | null;
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

export async function loginWithChatGPT(
  openUrl: (url: string) => void,
  onReady?: (handle: ChatGptLoginHandle) => void,
): Promise<CodexTokens> {
  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString("hex");

  const authUrl = new URL(AUTHORIZE_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", SCOPE);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("id_token_add_organizations", "true");
  authUrl.searchParams.set("codex_cli_simplified_flow", "true");
  authUrl.searchParams.set("originator", CODEX_ORIGINATOR);

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
      const url = new URL(req.url ?? "", `http://localhost:${CALLBACK_PORT}`);

      if (url.pathname !== "/auth/callback") {
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
        .writeHead(200, { "Content-Type": "text/html" })
        .end(
          "<html><body>OpenWiki login complete you can close this tab.</body></html>",
        );
      finish(authCode);
    });

    // Loopback only: never bind an unauthenticated code-capture endpoint to a
    // public interface.
    server.listen(CALLBACK_PORT, "localhost", () => {
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

  return exchangeToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  );
}

/**
 * Exchanges a refresh token for a fresh access token. OpenAI may rotate the
 * refresh token, so callers must persist whatever `refresh` comes back.
 */
export async function refreshChatGptTokens(
  refreshToken: string,
): Promise<CodexTokens> {
  return exchangeToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  );
}

/**
 * Whether a token expiring at `expiresAtMs` should be refreshed now, accounting
 * for the near-expiry threshold.
 */
export function isChatGptTokenExpired(
  expiresAtMs: number,
  now = Date.now(),
  thresholdMs = CHATGPT_TOKEN_REFRESH_THRESHOLD_MS,
): boolean {
  return !Number.isFinite(expiresAtMs) || now >= expiresAtMs - thresholdMs;
}
