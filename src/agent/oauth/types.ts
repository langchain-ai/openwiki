import type { OpenWikiProvider } from "../../constants.js";

/**
 * Best-effort human identity for display only. Never used for authentication.
 */
export interface OAuthIdentity {
  /**
   * Signed-in account email, if the provider exposes it.
   */
  email?: string;

  /**
   * Subscription plan or organization label, if the provider exposes it.
   */
  plan?: string;
}

/**
 * Tokens produced by an OAuth login or refresh, provider-agnostic.
 */
export interface OAuthTokens {
  /**
   * Access token (bearer).
   */
  access: string;

  /**
   * Refresh token; providers may rotate it, so always persist what comes back.
   */
  refresh: string;

  /**
   * Absolute access-token expiry, epoch milliseconds.
   */
  expiresAtMs: number;

  /**
   * Provider-required extras carried alongside the tokens (e.g. { accountId }).
   */
  extra: Record<string, string>;

  /**
   * Display identity resolved at login.
   */
  identity: OAuthIdentity;
}

/**
 * Lets the wizard complete a login from a manually pasted redirect URL or code
 * (for hosts where the browser cannot reach the loopback server).
 */
export interface OAuthLoginHandle {
  /**
   * Completes the login from a pasted redirect URL or bare code. Returns
   * undefined on success, or a human-readable error string to show inline
   * without aborting.
   */
  submitManual(input: string): string | undefined;
}

/**
 * The env-var names a provider persists its tokens under. `extra` maps each
 * extra-field name (e.g. "accountId") to its env key.
 */
export interface OAuthEnvKeys {
  /**
   * Env key holding the access token.
   */
  access: string;

  /**
   * Env key holding the refresh token.
   */
  refresh: string;

  /**
   * Env key holding the access-token expiry (epoch ms, as a string).
   */
  expiresAt: string;

  /**
   * Env key holding the display email.
   */
  email: string;

  /**
   * Env key holding the display plan or organization label.
   */
  plan: string;

  /**
   * Extra-field name to env key (e.g. { accountId: "OPENAI_CHATGPT_ACCOUNT_ID" }).
   */
  extra: Record<string, string>;
}

/**
 * Raw token-endpoint response shared by login and refresh. The three named
 * fields are required; the index signature carries vendor extras that identity
 * lives in for opaque-token providers (e.g. Claude returns `account` and
 * `organization` objects here, since its tokens are not JWTs).
 */
export interface OAuthTokenResponse {
  /**
   * The issued access token.
   */
  access_token: string;

  /**
   * The issued refresh token.
   */
  refresh_token: string;

  /**
   * Access-token lifetime in seconds.
   */
  expires_in: number;

  /**
   * Vendor extras (e.g. Claude's `account`/`organization`, `scope`, `token_type`).
   */
  [key: string]: unknown;
}

/**
 * Vendor-specific parameters the shared login/refresh flow needs.
 */
export interface OAuthFlowSpec {
  /**
   * OAuth client id (the vendor's first-party CLI client).
   */
  clientId: string;

  /**
   * Authorization endpoint the browser is sent to.
   */
  authorizeUrl: string;

  /**
   * Token endpoint for the code exchange and refresh.
   */
  tokenUrl: string;

  /**
   * Space-delimited scope string requested at authorize time.
   */
  scope: string;

  /**
   * Loopback port the callback server listens on (any free localhost port).
   */
  callbackPort: number;

  /**
   * Loopback callback path the redirect must match (e.g. "/callback").
   */
  callbackPath: string;

  /**
   * Token-endpoint request body encoding. OpenAI/Codex uses "form"
   * (application/x-www-form-urlencoded); Claude uses "json" (confirmed: a form
   * body is untested there, JSON returns 200).
   */
  tokenBodyFormat: "form" | "json";

  /**
   * Extra query params appended to the authorize URL.
   */
  extraAuthorizeParams?: Record<string, string>;
}

/**
 * The uniform interface every consumer (wizard, runtime) uses. One per provider.
 */
export interface OAuthAdapter {
  /**
   * Runs the browser login; resolves with tokens.
   */
  login(
    openUrl: (url: string) => void,
    onReady?: (handle: OAuthLoginHandle) => void,
  ): Promise<OAuthTokens>;

  /**
   * Exchanges a refresh token for fresh tokens.
   */
  refresh(refreshToken: string): Promise<OAuthTokens>;

  /**
   * Reads persisted tokens, or undefined if not fully present.
   */
  readTokensFromEnv(env?: NodeJS.ProcessEnv): OAuthTokens | undefined;

  /**
   * Serializes tokens to the provider's env keys.
   */
  tokensToEnv(tokens: OAuthTokens): Record<string, string>;

  /**
   * Whether the given expiry is due for refresh now.
   */
  isExpired(expiresAtMs: number, now?: number): boolean;

  /**
   * `email (Plan)` label from the persisted identity, for the run header.
   */
  formatAccountFromEnv(env?: NodeJS.ProcessEnv): string | undefined;
}
