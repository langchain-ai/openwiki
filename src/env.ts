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
  OPENROUTER_API_KEY_ENV_KEY,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
} from "./constants.js";

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

const managedEnvKeys = [
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
  "LANGSMITH_API_KEY",
  "LANGCHAIN_PROJECT",
  "LANGCHAIN_TRACING_V2",
];

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

  return [
    createCredentialDiagnostic(OPENWIKI_PROVIDER_ENV_KEY, fileEnv),
    createCredentialDiagnostic(BASETEN_API_KEY_ENV_KEY, fileEnv),
    createCredentialDiagnostic(FIREWORKS_API_KEY_ENV_KEY, fileEnv),
    createCredentialDiagnostic(OPENAI_API_KEY_ENV_KEY, fileEnv),
    createCredentialDiagnostic(OPENAI_COMPATIBLE_API_KEY_ENV_KEY, fileEnv),
    createCredentialDiagnostic(OPENAI_COMPATIBLE_BASE_URL_ENV_KEY, fileEnv),
    createCredentialDiagnostic(ANTHROPIC_API_KEY_ENV_KEY, fileEnv),
    createCredentialDiagnostic(ANTHROPIC_BASE_URL_ENV_KEY, fileEnv),
    createCredentialDiagnostic(OPENROUTER_API_KEY_ENV_KEY, fileEnv),
    createCredentialDiagnostic(OPENWIKI_MODEL_ID_ENV_KEY, fileEnv),
    createCredentialDiagnostic("LANGSMITH_API_KEY", fileEnv),
  ];
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

function parseEnv(content: string): EnvMap {
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

function formatEnv(env: EnvMap): string {
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

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
