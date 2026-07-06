import { createHash, randomBytes } from "node:crypto";
import http from "node:http";

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
 * Decodes the mandatory `chatgpt_account_id` claim from the access-token JWT.
 * No signature verification: these are our own credentials, read only for the
 * account-id header the Codex backend requires.
 */
function decodeAccountId(accessToken: string): string | null {
  const parts = accessToken.split(".");

  if (parts.length !== 3) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"];

    if (typeof auth !== "object" || auth === null) {
      return null;
    }

    const accountId = (auth as Record<string, unknown>).chatgpt_account_id;

    return typeof accountId === "string" ? accountId : null;
  } catch {
    return null;
  }
}

async function exchangeToken(body: URLSearchParams): Promise<CodexTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    throw new Error(
      `ChatGPT token request failed (${res.status}): ${await res.text()}`,
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
  const accountId = decodeAccountId(access);

  if (!accountId) {
    throw new Error("Failed to extract account id from ChatGPT access token.");
  }

  return {
    access,
    refresh: json.refresh_token as string,
    expiresAtMs: Date.now() + (json.expires_in as number) * 1000,
    accountId,
  };
}

/**
 * Runs the browser Authorization Code + PKCE login. `openUrl` is invoked once
 * the local callback server is listening: open a browser tab and/or print the
 * URL for headless use. Resolves with the exchanged tokens.
 */
export async function loginWithChatGPT(
  openUrl: (url: string) => void,
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
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "", `http://localhost:${CALLBACK_PORT}`);

      if (url.pathname !== "/auth/callback") {
        res.writeHead(404).end();
        return;
      }

      if (url.searchParams.get("state") !== state) {
        res.writeHead(400).end("State mismatch");
        server.close();
        reject(new Error("OAuth state mismatch"));
        return;
      }

      const authCode = url.searchParams.get("code");

      if (!authCode) {
        res.writeHead(400).end("Missing authorization code");
        server.close();
        reject(new Error("Missing authorization code"));
        return;
      }

      res
        .writeHead(200, { "Content-Type": "text/html" })
        .end(
          "<html><body>OpenWiki login complete — you can close this tab.</body></html>",
        );
      server.close();
      resolve(authCode);
    });

    // Loopback only: never bind an unauthenticated code-capture endpoint to a
    // public interface.
    server.listen(CALLBACK_PORT, "localhost", () =>
      openUrl(authUrl.toString()),
    );
    server.on("error", reject);
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
