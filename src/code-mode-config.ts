import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { isFileNotFoundError } from "./fs-errors.js";

export const CODE_MODE_CONFIG_FILENAME = "openwiki.config.yaml";
export const DEFAULT_CODE_MODE_AGENT_FILES_POLICY = "manage";

export type CodeModeAgentFilesPolicy = "manage" | "preserve";
export type CodeModeAgentFilesPolicySource = "cli" | "config" | "default";

export interface ResolvedCodeModeAgentFilesPolicy {
  /** Policy applied to the current run. */
  policy: CodeModeAgentFilesPolicy;
  /** Where the current run's policy came from. */
  source: CodeModeAgentFilesPolicySource;
  /** Committed policy used by later runs, or null when the default applies. */
  configuredPolicy: CodeModeAgentFilesPolicy | null;
}

export function isCodeModeAgentFilesPolicy(
  value: string,
): value is CodeModeAgentFilesPolicy {
  return value === "manage" || value === "preserve";
}

/**
 * Resolve the current code-mode agent-file policy without mutating repository
 * configuration. CLI overrides win over committed config, which wins over the
 * backward-compatible `manage` default.
 */
export async function resolveCodeModeAgentFilesPolicy(
  cwd: string,
  cliOverride: CodeModeAgentFilesPolicy | null = null,
): Promise<ResolvedCodeModeAgentFilesPolicy> {
  const configuredPolicy = await readConfiguredAgentFilesPolicy(cwd);

  if (cliOverride !== null) {
    return { configuredPolicy, policy: cliOverride, source: "cli" };
  }

  if (configuredPolicy !== null) {
    return {
      configuredPolicy,
      policy: configuredPolicy,
      source: "config",
    };
  }

  return {
    configuredPolicy: null,
    policy: DEFAULT_CODE_MODE_AGENT_FILES_POLICY,
    source: "default",
  };
}

async function readConfiguredAgentFilesPolicy(
  cwd: string,
): Promise<CodeModeAgentFilesPolicy | null> {
  let text: string;

  try {
    text = await readFile(path.join(cwd, CODE_MODE_CONFIG_FILENAME), "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return null;
    }
    throw error;
  }

  let config: unknown;
  try {
    config = parse(text) as unknown;
  } catch (error) {
    throw invalidConfig(errorMessage(error));
  }

  if (config === null || config === undefined) {
    return null;
  }
  if (!isRecord(config)) {
    throw invalidConfig("the document root must be a mapping.");
  }

  const codeMode = config.codeMode;
  if (codeMode === undefined) {
    return null;
  }
  if (!isRecord(codeMode)) {
    throw invalidConfig("codeMode must be a mapping.");
  }

  const agentFiles = codeMode.agentFiles;
  if (agentFiles === undefined) {
    return null;
  }
  if (!isRecord(agentFiles)) {
    throw invalidConfig("codeMode.agentFiles must be a mapping.");
  }

  const policy = agentFiles.policy;
  if (policy === undefined) {
    return null;
  }
  if (typeof policy !== "string" || !isCodeModeAgentFilesPolicy(policy)) {
    throw invalidConfig(
      "codeMode.agentFiles.policy must be manage or preserve.",
    );
  }

  return policy;
}

function invalidConfig(message: string): Error {
  return new Error(`Invalid ${CODE_MODE_CONFIG_FILENAME}: ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
