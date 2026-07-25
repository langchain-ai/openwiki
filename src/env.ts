import { mkdir, readFile, writeFile, chmod, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ANTHROPIC_API_KEY_ENV_KEY,
  ANTHROPIC_BASE_URL_ENV_KEY,
  BASETEN_API_KEY_ENV_KEY,
  BASETEN_BASE_URL_ENV_KEY,
  BEDROCK_AWS_ACCESS_KEY_ID_ENV_KEY,
  BEDROCK_AWS_REGION_ENV_KEY,
  BEDROCK_AWS_SECRET_ACCESS_KEY_ENV_KEY,
  FIREWORKS_API_KEY_ENV_KEY,
  FIREWORKS_BASE_URL_ENV_KEY,
  getProviderBaseUrlWarnings,
  GEMINI_API_KEY_ENV_KEY,
  GOOGLE_APPLICATION_CREDENTIALS_ENV_KEY,
  GOOGLE_CLOUD_LOCATION_ENV_KEY,
  GOOGLE_CLOUD_PROJECT_ENV_KEY,
  isValidModelId,
  NEBIUS_API_KEY_ENV_KEY,
  normalizeProvider,
  NVIDIA_API_KEY_ENV_KEY,
  NVIDIA_BASE_URL_ENV_KEY,
  OPENAI_API_KEY_ENV_KEY,
  OPENAI_BASE_URL_ENV_KEY,
  OPENAI_CHATGPT_ACCESS_TOKEN_ENV_KEY,
  OPENAI_CHATGPT_ACCOUNT_ID_ENV_KEY,
  OPENAI_CHATGPT_EMAIL_ENV_KEY,
  OPENAI_CHATGPT_EXPIRES_AT_ENV_KEY,
  OPENAI_CHATGPT_PLAN_ENV_KEY,
  OPENAI_CHATGPT_REFRESH_TOKEN_ENV_KEY,
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
  OPENWIKI_OPENROUTER_PROVIDER_ONLY_ENV_KEY,
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
import { restrictDirToCurrentUser } from "./windows-acl.js";

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
  BASETEN_BASE_URL_ENV_KEY,
  FIREWORKS_API_KEY_ENV_KEY,
  FIREWORKS_BASE_URL_ENV_KEY,
  NEBIUS_API_KEY_ENV_KEY,
  NVIDIA_API_KEY_ENV_KEY,
  NVIDIA_BASE_URL_ENV_KEY,
  OPENAI_API_KEY_ENV_KEY,
  OPENAI_BASE_URL_ENV_KEY,
  OPENAI_CHATGPT_ACCESS_TOKEN_ENV_KEY,
  OPENAI_CHATGPT_REFRESH_TOKEN_ENV_KEY,
  OPENAI_CHATGPT_EXPIRES_AT_ENV_KEY,
  OPENAI_CHATGPT_ACCOUNT_ID_ENV_KEY,
  OPENAI_CHATGPT_EMAIL_ENV_KEY,
  OPENAI_CHATGPT_PLAN_ENV_KEY,
  OPENAI_COMPATIBLE_API_KEY_ENV_KEY,
  OPENAI_COMPATIBLE_BASE_URL_ENV_KEY,
  ANTHROPIC_API_KEY_ENV_KEY,
  ANTHROPIC_BASE_URL_ENV_KEY,
  GEMINI_API_KEY_ENV_KEY,
  GOOGLE_CLOUD_PROJECT_ENV_KEY,
  GOOGLE_CLOUD_LOCATION_ENV_KEY,
  GOOGLE_APPLICATION_CREDENTIALS_ENV_KEY,
  OPENROUTER_API_KEY_ENV_KEY,
  OPENWIKI_OPENROUTER_PROVIDER_ONLY_ENV_KEY,
  BEDROCK_AWS_ACCESS_KEY_ID_ENV_KEY,
  BEDROCK_AWS_SECRET_ACCESS_KEY_ENV_KEY,
  BEDROCK_AWS_REGION_ENV_KEY,
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

const deprecatedEnvKeys = ["OPENAI_ORG_ID", "OPENAI_PROJECT"];

/**
 * The shell's values for managed credential keys, captured once before any load
 * or save wrote to `process.env`. A shell export keeps precedence over
 * `~/.openwiki/.env` at runtime, so this snapshot lets the wizard tell the user
 * when a value they save will be shadowed, and keeps {@link saveOpenWikiEnv}
 * from masking a shell var in-process. Held in memory only; never persisted or
 * logged.
 */
let shellEnvAtStartup: Record<string, string> | undefined;

/**
 * Snapshot the shell's values for managed credential keys. Idempotent: the
 * first call wins, so a later load or save cannot capture values OpenWiki
 * itself seeded into `process.env`.
 */
function captureShellEnv(): void {
  if (shellEnvAtStartup !== undefined) {
    return;
  }

  const snapshot: Record<string, string> = {};

  for (const key of CREDENTIAL_DIAGNOSTIC_ENV_KEYS) {
    const value = process.env[key];

    if (value !== undefined) {
      snapshot[key] = value;
    }
  }

  shellEnvAtStartup = snapshot;
}

/**
 * The shell value for a managed key as captured at startup, or `undefined` when
 * the shell did not set it. Reflects the pre-load snapshot, so it stays stable
 * even after {@link loadOpenWikiEnv} / {@link saveOpenWikiEnv} mutate
 * `process.env`.
 */
export function getShellEnvValue(key: string): string | undefined {
  return shellEnvAtStartup?.[key];
}

/**
 * The values saved in `~/.openwiki/.env` as of the first load, before shell
 * exports win in `process.env`. Lets the setup wizard pre-fill fields from the
 * saved config rather than `process.env` (which a shell var may shadow), so
 * editing config never captures a shell override. In memory only.
 */
let savedEnvAtStartup: Record<string, string> | undefined;

/**
 * The saved `~/.openwiki/.env` value for a key as of startup, or `undefined`.
 * Distinct from {@link getShellEnvValue} (the shell snapshot) and from
 * `process.env` (shell-over-file at runtime).
 */
export function getSavedEnvValue(key: string): string | undefined {
  return savedEnvAtStartup?.[key];
}

export async function loadOpenWikiEnv(): Promise<EnvMap> {
  captureShellEnv();

  const env = await readOpenWikiEnv();

  if (savedEnvAtStartup === undefined) {
    savedEnvAtStartup = { ...env };
  }

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
  captureShellEnv();

  const currentEnv = await readOpenWikiEnv();
  const nextEnv = {
    ...currentEnv,
    ...updates,
  };

  for (const key of deprecatedEnvKeys) {
    delete nextEnv[key];
  }

  // An empty value means "not set" (e.g. skipping the optional LangSmith key),
  // so drop the key rather than persisting KEY="" which would later read back
  // as configured. Also self-heals any empty values left by earlier writes.
  for (const key of Object.keys(nextEnv)) {
    if (nextEnv[key] === "") {
      delete nextEnv[key];
    }
  }

  await mkdir(openWikiEnvDir, {
    recursive: true,
    mode: 0o700,
  });
  await chmod(openWikiEnvDir, 0o700);
  await restrictDirToCurrentUser(openWikiEnvDir);

  // Write to a temp file in the same directory and atomically rename it into
  // place. A plain writeFile opens the existing credential file with O_TRUNC,
  // so a failure mid-write (ENOSPC, crash, power loss) would leave
  // ~/.openwiki/.env truncated and every saved token/key lost. The rename
  // keeps the original intact until the new contents are fully written.
  const tmpPath = `${openWikiEnvPath}.${process.pid}.tmp`;
  await writeFile(tmpPath, formatEnv(nextEnv), {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(tmpPath, 0o600);
  await rename(tmpPath, openWikiEnvPath);

  for (const [key, value] of Object.entries(updates)) {
    // A shell export wins at runtime, so don't mask it in process.env; the
    // saved value is only the fallback for when that shell var is unset.
    if (shellEnvAtStartup?.[key] !== undefined) {
      continue;
    }

    // Mirror the file: an empty value means "not set", so clear it from
    // process.env rather than leaving KEY="" (which reads back as configured).
    if (value === "") {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
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
            : (getBaseUrlDiagnosticWarnings(key, value) ??
              getCredentialWarnings(value)),
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

function getBaseUrlDiagnosticWarnings(
  key: string,
  value: string,
): string[] | undefined {
  if (key === ANTHROPIC_BASE_URL_ENV_KEY) {
    return getProviderBaseUrlWarnings("anthropic", value);
  }

  if (key === BASETEN_BASE_URL_ENV_KEY) {
    return getProviderBaseUrlWarnings("baseten", value);
  }

  if (key === FIREWORKS_BASE_URL_ENV_KEY) {
    return getProviderBaseUrlWarnings("fireworks", value);
  }

  if (key === NVIDIA_BASE_URL_ENV_KEY) {
    return getProviderBaseUrlWarnings("nvidia", value);
  }

  if (key === OPENAI_BASE_URL_ENV_KEY) {
    return getProviderBaseUrlWarnings("openai", value);
  }

  if (key === OPENAI_COMPATIBLE_BASE_URL_ENV_KEY) {
    return getProviderBaseUrlWarnings("openai-compatible", value);
  }

  return undefined;
}

function isNonSecretDiagnosticKey(key: string): boolean {
  return (
    key === OPENWIKI_MODEL_ID_ENV_KEY ||
    key === OPENWIKI_PROVIDER_ENV_KEY ||
    key === OPENWIKI_PROVIDER_RETRY_ATTEMPTS_ENV_KEY ||
    key === OPENWIKI_OPENROUTER_PROVIDER_ONLY_ENV_KEY ||
    key === ANTHROPIC_BASE_URL_ENV_KEY ||
    key === BASETEN_BASE_URL_ENV_KEY ||
    key === FIREWORKS_BASE_URL_ENV_KEY ||
    key === NVIDIA_BASE_URL_ENV_KEY ||
    key === OPENAI_BASE_URL_ENV_KEY ||
    key === OPENAI_COMPATIBLE_BASE_URL_ENV_KEY ||
    key === BEDROCK_AWS_REGION_ENV_KEY ||
    key === GOOGLE_CLOUD_PROJECT_ENV_KEY ||
    key === GOOGLE_CLOUD_LOCATION_ENV_KEY ||
    key === GOOGLE_APPLICATION_CREDENTIALS_ENV_KEY
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

    // Handle "export KEY=value" syntax
    const exportPrefix = "export ";
    const lineToParse = line.startsWith(exportPrefix)
      ? line.slice(exportPrefix.length)
      : line;

    const equalsIndex = lineToParse.indexOf("=");

    if (equalsIndex <= 0) {
      continue;
    }

    const key = lineToParse.slice(0, equalsIndex).trim();
    const rawValue = lineToParse.slice(equalsIndex + 1).trim();

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
      .replace(/\\r/gu, "\r")
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
    .replace(/\n/gu, "\\n")
    .replace(/\r/gu, "\\r")}"`;
}
