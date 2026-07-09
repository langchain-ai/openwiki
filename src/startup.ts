import { shouldCheckUpdateNoop, getUpdateNoopStatus } from "./agent/utils.js";
import type { CliCommand } from "./commands.js";
import {
  getProviderApiKeyEnvKey,
  resolveConfiguredProvider,
} from "./constants.js";

type ResolveStartupCommandOptions = {
  cwd?: string;
  isStdinTTY?: boolean;
};

export async function resolveStartupCommand(
  command: CliCommand,
  options: ResolveStartupCommandOptions = {},
): Promise<CliCommand> {
  const isStdinTTY = options.isStdinTTY ?? Boolean(process.stdin.isTTY);

  if (
    command.kind === "run" &&
    !command.dryRun &&
    !command.shouldStart &&
    !isStdinTTY
  ) {
    return {
      kind: "error",
      exitCode: 1,
      message:
        "Interactive chat requires a terminal. Pass a message or use --init or --update for non-interactive runs.",
    };
  }

  if (
    command.kind === "run" &&
    !command.dryRun &&
    command.shouldStart &&
    (command.print || !isStdinTTY)
  ) {
    const provider = resolveConfiguredProvider();
    const apiKeyEnvKey = getProviderApiKeyEnvKey(provider);
    const hasProviderKey = Boolean(process.env[apiKeyEnvKey]);

    if (!hasProviderKey) {
      if (
        command.print &&
        (await canSkipCleanUpdateBeforeCredentials(
          command,
          options.cwd ?? process.cwd(),
        ))
      ) {
        return command;
      }

      return {
        kind: "error",
        exitCode: 1,
        message: `${apiKeyEnvKey} is required for non-interactive runs. Run openwiki in an interactive terminal to save credentials.`,
      };
    }
  }

  if (
    command.kind === "run" &&
    !command.dryRun &&
    command.userMessage !== null &&
    command.userMessage.trim().length === 0
  ) {
    return {
      kind: "error",
      exitCode: 1,
      message: "User message cannot be empty.",
    };
  }

  return command;
}

async function canSkipCleanUpdateBeforeCredentials(
  command: Extract<CliCommand, { kind: "run" }>,
  cwd: string,
): Promise<boolean> {
  if (
    command.command !== "update" ||
    command.userMessage !== null ||
    !shouldCheckUpdateNoop({ userMessage: command.userMessage })
  ) {
    return false;
  }

  try {
    const noopStatus = await getUpdateNoopStatus(cwd);

    return noopStatus.shouldSkip;
  } catch {
    return false;
  }
}
