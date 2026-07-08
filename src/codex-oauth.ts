import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseMessage } from "@langchain/core/messages";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { ChatGenerationChunk } from "@langchain/core/outputs";
import type { ChatModelStreamEvent } from "@langchain/core/language_models/event";

export const CODEX_OAUTH_PROVIDER = "codex-oauth";
export const CODEX_OAUTH_PATH = path.join(os.homedir(), ".openwiki", "codex-oauth.json");
export const CODEX_BACKEND_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CODEX_OAUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const CODEX_DEFAULT_INSTRUCTIONS =
  "You are ChatGPT, a large language model trained by OpenAI.";

const CODEX_ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;
const CODEX_OAUTH_SCOPE = "openid profile email offline_access";

type CodexOAuthTokenSet = {
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  accountId: string;
  planType: string | null;
  expiresAt: string;
};

type CodexOAuthPendingLogin = {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: string;
};

type CodexOAuthFile = {
  tokens?: CodexOAuthTokenSet;
  pending?: CodexOAuthPendingLogin;
  updatedAt?: string;
};

export type CodexOAuthCredentials = {
  accessToken: string;
  accountId: string;
};

export type CodexOAuthLoginStart = {
  authorizeUrl: string;
  state: string;
};

type CodexOAuthOptions = {
  authPath?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: Date;
  randomBytes?: (size: number) => Buffer;
};

type TokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  expires_in?: unknown;
};

type JwtAuthClaims = {
  chatgpt_account_id?: unknown;
  chatgpt_plan_type?: unknown;
};

type JwtClaims = {
  exp?: unknown;
  ["https://api.openai.com/auth"]?: JwtAuthClaims;
};

export async function startCodexOAuthLogin(
  options: CodexOAuthOptions = {},
): Promise<CodexOAuthLoginStart> {
  const now = options.now ?? new Date();
  const randomBytes = options.randomBytes ?? nodeRandomBytes;
  const codeVerifier = base64Url(randomBytes(32));
  const state = base64Url(randomBytes(24));
  const codeChallenge = base64Url(
    createHash("sha256").update(codeVerifier).digest(),
  );
  const authorizeUrl = new URL(CODEX_OAUTH_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", CODEX_OAUTH_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", CODEX_OAUTH_REDIRECT_URI);
  authorizeUrl.searchParams.set("scope", CODEX_OAUTH_SCOPE);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("originator", "openwiki");

  const authPath = options.authPath ?? CODEX_OAUTH_PATH;
  const authFile = await readCodexOAuthFile(authPath);
  await writeCodexOAuthFile(authPath, {
    ...authFile,
    pending: {
      codeVerifier,
      createdAt: now.toISOString(),
      redirectUri: CODEX_OAUTH_REDIRECT_URI,
      state,
    },
    updatedAt: now.toISOString(),
  });

  return { authorizeUrl: authorizeUrl.toString(), state };
}

export async function completeCodexOAuthLogin(
  callbackUrl: string,
  options: CodexOAuthOptions = {},
): Promise<CodexOAuthCredentials> {
  const authPath = options.authPath ?? CODEX_OAUTH_PATH;
  const authFile = await readCodexOAuthFile(authPath);
  const pending = authFile.pending;

  if (!pending) {
    throw new Error("No pending Codex OAuth login. Run `openwiki login codex-oauth` first.");
  }

  const callback = parseCodexOAuthCallbackUrl(callbackUrl);

  if (callback.state !== pending.state) {
    throw new Error("Codex OAuth callback state did not match the pending login.");
  }

  const tokenResponse = await exchangeCodexAuthorizationCode(
    callback.code,
    pending.codeVerifier,
    pending.redirectUri,
    options.fetch ?? fetch,
  );
  const tokens = normalizeTokenResponse(tokenResponse, options.now ?? new Date());

  await writeCodexOAuthFile(authPath, {
    tokens,
    updatedAt: (options.now ?? new Date()).toISOString(),
  });

  return { accessToken: tokens.accessToken, accountId: tokens.accountId };
}

export async function resolveCodexOAuthCredentials(
  options: CodexOAuthOptions = {},
): Promise<CodexOAuthCredentials> {
  const authPath = options.authPath ?? CODEX_OAUTH_PATH;
  const authFile = await readCodexOAuthFile(authPath);
  const tokens = authFile.tokens;

  if (!tokens) {
    throw new Error("Codex OAuth is not configured. Run `openwiki login codex-oauth` first.");
  }

  const now = options.now ?? new Date();

  if (!shouldRefreshAccessToken(tokens, now)) {
    return { accessToken: tokens.accessToken, accountId: tokens.accountId };
  }

  const refreshed = await refreshCodexOAuthTokens(
    tokens.refreshToken,
    options.fetch ?? fetch,
  );
  const nextTokens = normalizeTokenResponse(refreshed, now, tokens);

  await writeCodexOAuthFile(authPath, {
    ...authFile,
    tokens: nextTokens,
    updatedAt: now.toISOString(),
  });

  return { accessToken: nextTokens.accessToken, accountId: nextTokens.accountId };
}

export function parseCodexOAuthCallbackUrl(callbackUrl: string): {
  code: string;
  state: string;
} {
  let parsed: URL;

  try {
    parsed = new URL(callbackUrl.trim());
  } catch {
    throw new Error("Paste the full Codex OAuth callback URL, including code and state.");
  }

  const error = parsed.searchParams.get("error");

  if (error) {
    throw new Error(`Codex OAuth returned an error: ${error}`);
  }

  const code = parsed.searchParams.get("code");
  const state = parsed.searchParams.get("state");

  if (!code || !state) {
    throw new Error("Codex OAuth callback URL must include code and state parameters.");
  }

  return { code, state };
}

async function exchangeCodexAuthorizationCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  fetchImpl: typeof fetch,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: CODEX_OAUTH_CLIENT_ID,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  const response = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });

  return parseTokenResponse(response, "Codex OAuth token exchange");
}

async function refreshCodexOAuthTokens(
  refreshToken: string,
  fetchImpl: typeof fetch,
): Promise<TokenResponse> {
  const response = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  return parseTokenResponse(response, "Codex OAuth token refresh");
}

async function parseTokenResponse(
  response: Response,
  operation: string,
): Promise<TokenResponse> {
  const parsed: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      isRecord(parsed) && typeof parsed.error === "string"
        ? parsed.error
        : `HTTP ${response.status}`;
    throw new Error(`${operation} failed: ${message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`${operation} response was not a JSON object.`);
  }

  return parsed;
}

function normalizeTokenResponse(
  response: TokenResponse,
  now: Date,
  previous?: CodexOAuthTokenSet,
): CodexOAuthTokenSet {
  const accessToken = getStringField(response, "access_token") ?? previous?.accessToken;
  const refreshToken = getStringField(response, "refresh_token") ?? previous?.refreshToken;
  const idToken = getStringField(response, "id_token") ?? previous?.idToken ?? null;

  if (!accessToken) {
    throw new Error("Codex OAuth response did not include an access token.");
  }

  if (!refreshToken) {
    throw new Error("Codex OAuth response did not include a refresh token.");
  }

  if (!idToken) {
    throw new Error("Codex OAuth response did not include an ID token.");
  }

  const idTokenClaims = parseJwtClaims(idToken);
  const authClaims = idTokenClaims["https://api.openai.com/auth"];
  const accountId =
    getStringField(authClaims, "chatgpt_account_id") ?? previous?.accountId;

  if (!accountId) {
    throw new Error("Codex OAuth ID token did not include a ChatGPT account ID.");
  }

  const expiresAt = getTokenExpiration(response, accessToken, now);

  return {
    accessToken,
    accountId,
    expiresAt: expiresAt.toISOString(),
    idToken,
    planType: getStringField(authClaims, "chatgpt_plan_type") ?? previous?.planType ?? null,
    refreshToken,
  };
}

function getTokenExpiration(
  response: TokenResponse,
  accessToken: string,
  now: Date,
): Date {
  if (typeof response.expires_in === "number" && Number.isFinite(response.expires_in)) {
    return new Date(now.getTime() + response.expires_in * 1000);
  }

  const exp = parseJwtClaims(accessToken).exp;

  if (typeof exp === "number" && Number.isFinite(exp)) {
    return new Date(exp * 1000);
  }

  return new Date(now.getTime() + 60 * 60 * 1000);
}

function shouldRefreshAccessToken(tokens: CodexOAuthTokenSet, now: Date): boolean {
  const expiresAtMs = Date.parse(tokens.expiresAt);

  return (
    Number.isFinite(expiresAtMs) &&
    expiresAtMs - now.getTime() <= CODEX_ACCESS_TOKEN_REFRESH_WINDOW_MS
  );
}

async function readCodexOAuthFile(authPath: string): Promise<CodexOAuthFile> {
  let raw: string;

  try {
    raw = await readFile(authPath, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return {};
    }

    throw error;
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to the consistent parse error below.
  }

  throw new Error(`Codex OAuth credentials at ${authPath} are not valid JSON.`);
}

async function writeCodexOAuthFile(
  authPath: string,
  authFile: CodexOAuthFile,
): Promise<void> {
  await mkdir(path.dirname(authPath), { recursive: true });
  await writeFile(authPath, `${JSON.stringify(authFile, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(authPath, 0o600);
}

function parseJwtClaims(token: string): JwtClaims {
  const [, payload] = token.split(".");

  if (!payload) {
    return {};
  }

  try {
    const normalized = payload.replace(/-/gu, "+").replace(/_/gu, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    const parsed: unknown = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));

    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getStringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = record?.[key];

  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    isRecord(error) &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

type CodexChatOpenAIFields = ConstructorParameters<typeof ChatOpenAI>[0] & {
  codexCredentials: CodexOAuthCredentials;
};

export class CodexChatOpenAI extends ChatOpenAI {
  constructor(fields: CodexChatOpenAIFields) {
    const { codexCredentials, ...chatFields } = fields;

    super({
      ...chatFields,
      apiKey: codexCredentials.accessToken,
      configuration: {
        ...chatFields.configuration,
        baseURL: CODEX_BACKEND_BASE_URL,
        defaultHeaders: {
          ...chatFields.configuration?.defaultHeaders,
          "ChatGPT-Account-Id": codexCredentials.accountId,
          originator: "openwiki",
        },
      },
      modelKwargs: {
        ...chatFields.modelKwargs,
        instructions: CODEX_DEFAULT_INSTRUCTIONS,
        store: false,
      },
      streaming: true,
      useResponsesApi: true,
      zdrEnabled: true,
    });

    this.installCodexResponseGuards();
  }

  private installCodexResponseGuards(): void {
    const originalGenerate = this.responses._generate.bind(this.responses);
    const originalStreamChunks = this.responses._streamResponseChunks.bind(
      this.responses,
    );
    const originalStreamEvents = this.responses._streamChatModelEvents.bind(
      this.responses,
    );

    this.responses._generate = (messages, options, runManager) =>
      this.withCodexInstructions(messages, (nextMessages) =>
        originalGenerate(nextMessages, options, runManager),
      );

    this.responses._streamResponseChunks = (messages, options, runManager) =>
      this.streamResponseChunksWithCodexInstructions(
        originalStreamChunks,
        messages,
        options,
        runManager,
      );

    this.responses._streamChatModelEvents = (messages, options, runManager) =>
      this.streamChatModelEventsWithCodexInstructions(
        originalStreamEvents,
        messages,
        options,
        runManager,
      );
  }

  private async *streamResponseChunksWithCodexInstructions(
    streamChunks: (
      messages: BaseMessage[],
      options: this["ParsedCallOptions"],
      runManager?: CallbackManagerForLLMRun,
    ) => AsyncGenerator<ChatGenerationChunk>,
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const lifted = liftCodexInstructions(messages);
    const restore = this.applyCodexInstructions(lifted.instructions);

    try {
      yield* streamChunks(lifted.messages, options, runManager);
    } finally {
      restore();
    }
  }

  private async *streamChatModelEventsWithCodexInstructions(
    streamEvents: (
      messages: BaseMessage[],
      options: this["ParsedCallOptions"],
      runManager?: CallbackManagerForLLMRun,
    ) => AsyncGenerator<ChatModelStreamEvent>,
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatModelStreamEvent> {
    const lifted = liftCodexInstructions(messages);
    const restore = this.applyCodexInstructions(lifted.instructions);

    try {
      yield* streamEvents(lifted.messages, options, runManager);
    } finally {
      restore();
    }
  }

  private async withCodexInstructions<T>(
    messages: BaseMessage[],
    run: (messages: BaseMessage[]) => Promise<T>,
  ): Promise<T> {
    const lifted = liftCodexInstructions(messages);
    const restore = this.applyCodexInstructions(lifted.instructions);

    try {
      return await run(lifted.messages);
    } finally {
      restore();
    }
  }

  private applyCodexInstructions(instructions: string): () => void {
    const previous = this.responses.modelKwargs;

    this.responses.modelKwargs = {
      ...previous,
      instructions,
      store: false,
    };

    return () => {
      this.responses.modelKwargs = previous;
    };
  }
}

function liftCodexInstructions(messages: BaseMessage[]): {
  instructions: string;
  messages: BaseMessage[];
} {
  const instructions: string[] = [];
  const nextMessages: BaseMessage[] = [];

  for (const message of messages) {
    if (isInstructionMessage(message)) {
      instructions.push(flattenMessageContent(message.content));
    } else {
      nextMessages.push(message);
    }
  }

  return {
    instructions:
      instructions.filter(Boolean).join("\n\n") || CODEX_DEFAULT_INSTRUCTIONS,
    messages: nextMessages,
  };
}

function isInstructionMessage(message: BaseMessage): boolean {
  const messageType = message._getType();

  return (
    messageType === "system" ||
    (messageType === "generic" &&
      "role" in message &&
      (message.role === "system" || message.role === "developer"))
  );
}

function flattenMessageContent(content: BaseMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (isRecord(part) && typeof part.text === "string") {
        return part.text;
      }

      return "";
    })
    .join("");
}

export function createSyntheticJwt(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHash("sha256").update(payload).digest("base64url");

  return `header.${payload}.${signature}`;
}
