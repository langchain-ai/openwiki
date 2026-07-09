import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ANTHROPIC_API_KEY_ENV_KEY,
  ANTHROPIC_BASE_URL_ENV_KEY,
  BASETEN_API_KEY_ENV_KEY,
  FIREWORKS_API_KEY_ENV_KEY,
  isValidModelId,
  normalizeProvider,
  OPENAI_API_KEY_ENV_KEY,
  OPENAI_COMPATIBLE_API_KEY_ENV_KEY,
  OPENAI_COMPATIBLE_BASE_URL_ENV_KEY,
  OPENWIKI_GOOGLE_ACCESS_TOKEN_ENV_KEY,
  OPENWIKI_GOOGLE_CLIENT_ID_ENV_KEY,
  OPENWIKI_GOOGLE_CLIENT_SECRET_ENV_KEY,
  OPENWIKI_GOOGLE_REFRESH_TOKEN_ENV_KEY,
  OPENWIKI_GMAIL_ACCESS_TOKEN_ENV_KEY,
  OPENWIKI_GMAIL_REFRESH_TOKEN_ENV_KEY,
  OPENWIKI_NOTION_MCP_ACCESS_TOKEN_ENV_KEY,
  OPENWIKI_NOTION_MCP_CLIENT_ID_ENV_KEY,
  OPENWIKI_NOTION_MCP_REFRESH_TOKEN_ENV_KEY,
  OPENROUTER_API_KEY_ENV_KEY,
  OPENWIKI_NOTION_TOKEN_ENV_KEY,
  OPENWIKI_SLACK_BOT_TOKEN_ENV_KEY,
  OPENWIKI_SLACK_CLIENT_ID_ENV_KEY,
  OPENWIKI_SLACK_CLIENT_SECRET_ENV_KEY,
  OPENWIKI_SLACK_USER_TOKEN_ENV_KEY,
  OPENWIKI_X_ACCESS_TOKEN_ENV_KEY,
  OPENWIKI_X_CLIENT_ID_ENV_KEY,
  OPENWIKI_X_CLIENT_SECRET_ENV_KEY,
  OPENWIKI_X_REFRESH_TOKEN_ENV_KEY,
  OPENWIKI_TAVILY_API_KEY_ENV_KEY,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
  OPENWIKI_PROVIDER_RETRY_ATTEMPTS_ENV_KEY,
  resolveProviderRetryAttempts,
} from "./constants.js";
import { isFileNotFoundError } from "./fs-errors.js";

export const openWikiEnvDir = path.join(os.homedir(), ".openwiki");
export const openWikiEnvPath = path.join(openWikiEnvDir, ".env");

type EnvMap = Record<string, string>;

export type CredentialDiagnostic = {
  key: string;
  source:
    | "process.env"
    | "~/.openwiki/.env"
    | "process.env over ~/.openwiki/.env"
    | "unset";
  length: number | null;
  preview: string;
  warnings: string[];
};

/**
 * Every environment variable OpenWiki reads or persists, in the order they are
 * written to `~/.openwiki/.env`. This is the single source of truth: the
 * credential diagnostics list and the agent's debug-dump key list are both
 * derived from it (see {@link CREDENTIAL_DIAGNOSTIC_ENV_KEYS} and
 * {@link DEBUG_ENV_KEYS}), so they cannot silently drift out of sync when a new
 * managed key is added.
 */
export const MANAGED_ENV_KEYS = [
  BASETEN_API_KEY_ENV_KEY,
  FIREWORKS_API_KEY_ENV_KEY,
  OPENAI_API_KEY_ENV_KEY,
  OPENAI_COMPATIBLE_API_KEY_ENV_KEY,
  OPENAI_COMPATIBLE_BASE_URL_ENV_KEY,
  ANTHROPIC_API_KEY_ENV_KEY,
  ANTHROPIC_BASE_URL_ENV_KEY,
  OPENROUTER_API_KEY_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_RETRY_ATTEMPTS_ENV_KEY,
  OPENWIKI_NOTION_TOKEN_ENV_KEY,
  OPENWIKI_NOTION_MCP_CLIENT_ID_ENV_KEY,
  OPENWIKI_NOTION_MCP_ACCESS_TOKEN_ENV_KEY,
  OPENWIKI_NOTION_MCP_REFRESH_TOKEN_ENV_KEY,
  OPENWIKI_SLACK_BOT_TOKEN_ENV_KEY,
  OPENWIKI_SLACK_CLIENT_ID_ENV_KEY,
  OPENWIKI_SLACK_CLIENT_SECRET_ENV_KEY,
  OPENWIKI_SLACK_USER_TOKEN_ENV_KEY,
  OPENWIKI_GMAIL_ACCESS_TOKEN_ENV_KEY,
  OPENWIKI_GMAIL_REFRESH_TOKEN_ENV_KEY,
  OPENWIKI_GOOGLE_CLIENT_ID_ENV_KEY,
  OPENWIKI_GOOGLE_CLIENT_SECRET_ENV_KEY,
  OPENWIKI_GOOGLE_ACCESS_TOKEN_ENV_KEY,
  OPENWIKI_GOOGLE_REFRESH_TOKEN_ENV_KEY,
  OPENWIKI_X_CLIENT_ID_ENV_KEY,
  OPENWIKI_X_CLIENT_SECRET_ENV_KEY,
  OPENWIKI_X_ACCESS_TOKEN_ENV_KEY,
  OPENWIKI_X_REFRESH_TOKEN_ENV_KEY,
  OPENWIKI_TAVILY_API_KEY_ENV_KEY,
  "OPENWIKI_HTTPS_OAUTH_REDIRECT_URI",
  "OPENWIKI_OAUTH_CALLBACK_PORT",
  "LANGSMITH_API_KEY",
  "LANGCHAIN_PROJECT",
  "LANGCHAIN_TRACING_V2",
] as const;

// LangChain project/tracing settings are managed but are not credentials, so
// they are excluded from the diagnostics panel.
const NON_CREDENTIAL_ENV_KEYS = new Set<string>([
  "LANGCHAIN_PROJECT",
  "LANGCHAIN_TRACING_V2",
]);

/**
 * Managed keys surfaced (in display order) in the credential diagnostics panel:
 * the provider/model settings and every credential, but not the LangChain
 * project/tracing settings. Derived from {@link MANAGED_ENV_KEYS} so a new
 * credential key automatically appears in diagnostics.
 */
export const CREDENTIAL_DIAGNOSTIC_ENV_KEYS: readonly string[] = [
  OPENWIKI_PROVIDER_ENV_KEY,
  ...MANAGED_ENV_KEYS.filter(
    (key) =>
      key !== OPENWIKI_PROVIDER_ENV_KEY && !NON_CREDENTIAL_ENV_KEYS.has(key),
  ),
];

/**
 * Keys dumped in the agent's environment debug line: every managed key plus the
 * LangChain endpoint override that OpenWiki reads but never persists. Derived
 * from {@link MANAGED_ENV_KEYS} so it cannot drift.
 */
export const DEBUG_ENV_KEYS: readonly string[] = [
  ...MANAGED_ENV_KEYS,
  "LANGCHAIN_ENDPOINT",
];

const managedEnvKeys: readonly string[] = MANAGED_ENV_KEYS;

const deprecatedEnvKeys = [
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT",
];

export async function loadOpenWikiEnv(): Promise<EnvMap> {
  const env = await readOpenWikiEnv();

  for (const [key, value] of Object.entries(env)) {
    if (deprecatedEnvKeys.includes(key)) {
      continue;
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return env;
}

export async function getCredentialDiagnostics(): Promise<
  CredentialDiagnostic[]
> {
  const fileEnv = await readOpenWikiEnv();

  return CREDENTIAL_DIAGNOSTIC_ENV_KEYS.map((key) =>
    createCredentialDiagnostic(key, fileEnv),
  );
}

export async function saveOpenWikiEnv(updates: EnvMap): Promise<void> {
  const currentEnv = await readOpenWikiEnv();
  const nextEnv = {
    ...currentEnv,
    ...updates,
  };

  for (const key of deprecatedEnvKeys) {
    delete nextEnv[key];
  }

  await mkdir(openWikiEnvDir, {
    recursive: true,
    mode: 0o700,
  });
  await chmod(openWikiEnvDir, 0o700);

  await writeFile(openWikiEnvPath, formatEnv(nextEnv), {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(openWikiEnvPath, 0o600);

  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = value;
  }
}

function createCredentialDiagnostic(
  key: CredentialDiagnostic["key"],
  fileEnv: EnvMap,
): CredentialDiagnostic {
  const processValue = process.env[key];
  const fileValue = fileEnv[key];
  const value = processValue ?? fileValue;
  const source = getCredentialSource(processValue, fileValue);

  if (value === undefined) {
    return {
      key,
      source,
      length: null,
      preview: "<unset>",
      warnings: [],
    };
  }

  return {
    key,
    source,
    length: value.length,
    preview: isNonSecretDiagnosticKey(key)
      ? JSON.stringify(value)
      : createCredentialPreview(value),
    warnings:
      key === OPENWIKI_MODEL_ID_ENV_KEY
        ? getModelWarnings(value)
        : key === OPENWIKI_PROVIDER_ENV_KEY
          ? getProviderWarnings(value)
          : key === OPENWIKI_PROVIDER_RETRY_ATTEMPTS_ENV_KEY
            ? getRetryAttemptsWarnings(value)
            : getCredentialWarnings(value),
  };
}

function getCredentialSource(
  processValue: string | undefined,
  fileValue: string | undefined,
): CredentialDiagnostic["source"] {
  if (processValue !== undefined && fileValue !== undefined) {
    return "process.env over ~/.openwiki/.env";
  }

  if (processValue !== undefined) {
    return "process.env";
  }

  if (fileValue !== undefined) {
    return "~/.openwiki/.env";
  }

  return "unset";
}

function isNonSecretDiagnosticKey(key: string): boolean {
  return (
    key === OPENWIKI_MODEL_ID_ENV_KEY ||
    key === OPENWIKI_PROVIDER_ENV_KEY ||
    key === OPENWIKI_PROVIDER_RETRY_ATTEMPTS_ENV_KEY ||
    key === ANTHROPIC_BASE_URL_ENV_KEY ||
    key === OPENAI_COMPATIBLE_BASE_URL_ENV_KEY
  );
}

function createCredentialPreview(value: string): string {
  if (value.length <= 10) {
    return JSON.stringify("*".repeat(value.length));
  }

  return JSON.stringify(`${value.slice(0, 6)}...${value.slice(-4)}`);
}

function getCredentialWarnings(value: string): string[] {
  const warnings: string[] = [];

  if (value !== value.trim()) {
    warnings.push("leading/trailing whitespace");
  }

  if (value.includes("\n") || value.includes("\r")) {
    warnings.push("contains newline");
  }

  if (value.includes('"') || value.includes("'")) {
    warnings.push("contains quote character");
  }

  if (/\[[^\]]+\]/u.test(value)) {
    warnings.push("contains bracketed suffix/text");
  }

  return warnings;
}

function getModelWarnings(value: string): string[] {
  return isValidModelId(value) ? [] : ["invalid model ID"];
}

function getProviderWarnings(value: string): string[] {
  return normalizeProvider(value) === null ? ["invalid provider"] : [];
}

function getRetryAttemptsWarnings(value: string): string[] {
  try {
    resolveProviderRetryAttempts({
      [OPENWIKI_PROVIDER_RETRY_ATTEMPTS_ENV_KEY]: value,
    });

    return [];
  } catch {
    return ["invalid retry attempts"];
  }
}

async function readOpenWikiEnv(): Promise<EnvMap> {
  try {
    return parseEnv(await readFile(openWikiEnvPath, "utf8"));
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return {};
    }

    throw error;
  }
}

export function parseEnv(content: string): EnvMap {
  const env: EnvMap = {};

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();

    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");

    if (equalsIndex <= 0) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    const rawValue = line.slice(equalsIndex + 1).trim();

    if (!/^[A-Z_][A-Z0-9_]*$/u.test(key)) {
      continue;
    }

    env[key] = parseEnvValue(rawValue);
  }

  return env;
}

function parseEnvValue(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/gu, "\n")
      .replace(/\\"/gu, '"')
      .replace(/\\\\/gu, "\\");
  }

  return value;
}

export function formatEnv(env: EnvMap): string {
  const keys = [
    ...managedEnvKeys.filter((key) => env[key] !== undefined),
    ...Object.keys(env)
      .filter((key) => !managedEnvKeys.includes(key))
      .sort(),
  ];

  return `${keys.map((key) => `${key}=${formatEnvValue(env[key] ?? "")}`).join("\n")}\n`;
}

function formatEnvValue(value: string): string {
  return `"${value
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\n/gu, "\\n")}"`;
}
