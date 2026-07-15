import { shouldCheckUpdateNoop, getUpdateNoopStatus } from "./agent/utils.js";
import type { CliCommand } from "./commands.js";
import {
  getMissingProviderEnvKey,
  getProviderCredentialHint,
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
    const missingEnvKey = getMissingProviderEnvKey(provider);

    if (missingEnvKey) {
      if (
        command.print &&
        (await canSkipCleanUpdateBeforeCredentials(
          command,
          options.cwd ?? process.cwd(),
        ))
      ) {
        return command;
      }

      const hint = getProviderCredentialHint(provider);

      return {
        kind: "error",
        exitCode: 1,
        message: `${missingEnvKey} is required for non-interactive runs. Run openwiki in an interactive terminal to save credentials.${
          hint ? ` ${hint}` : ""
        }`,
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
