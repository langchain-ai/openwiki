import { isValidModelId, normalizeModelId } from "./constants.js";
import type { OpenWikiCommand } from "./agent/types.js";

export type HelpRow = {
  label: string;
  description: string;
};

export type HelpContent = {
  title: string;
  description: string;
  usage: string[];
  commands: HelpRow[];
  options: HelpRow[];
  developmentOptions: HelpRow[];
  examples: string[];
  developmentExamples: string[];
};

export type CliCommand =
  | { kind: "help"; exitCode: 0 }
  | {
      kind: "run";
      exitCode: 0;
      command: OpenWikiCommand;
      dryRun: boolean;
      modelId: string | null;
      print: boolean;
      shouldStart: boolean;
      userMessage: string | null;
    }
  | {
      kind: "login";
      exitCode: 0;
      provider: "codex-oauth";
    }
  | {
      kind: "error";
      exitCode: 1;
      message: string;
    };

export function parseCommand(argv: string[]): CliCommand {
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { kind: "help", exitCode: 0 };
  }

  if (argv[0] === "login") {
    if (argv[1] === "codex-oauth" && argv.length === 2) {
      return { kind: "login", exitCode: 0, provider: "codex-oauth" };
    }

    return {
      kind: "error",
      exitCode: 1,
      message: "Usage: openwiki login codex-oauth",
    };
  }

  let dryRun = false;
  let modelId: string | null = null;
  let print = false;
  let command: OpenWikiCommand = "chat";
  const userMessageParts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      return { kind: "help", exitCode: 0 };
    }

    if (arg === "--dry-run") {
      if (!isDevelopmentMode()) {
        return {
          kind: "error",
          exitCode: 1,
          message: `Unknown option: ${arg}`,
        };
      }

      dryRun = true;
      continue;
    }

    if (arg === "--print" || arg === "-p") {
      print = true;
      continue;
    }

    if (arg === "--init" || arg === "--update") {
      const nextCommand = arg === "--init" ? "init" : "update";

      if (command !== "chat" && command !== nextCommand) {
        return {
          kind: "error",
          exitCode: 1,
          message: "--init and --update cannot be used together.",
        };
      }

      command = nextCommand;
      continue;
    }

    if (arg === "--modelId" || arg === "--model-id") {
      const nextArg = argv[index + 1];

      if (!nextArg || nextArg.startsWith("-")) {
        return {
          kind: "error",
          exitCode: 1,
          message: `${arg} requires a model ID.`,
        };
      }

      const parsedModelId = normalizeModelId(nextArg);

      if (!isValidModelId(parsedModelId)) {
        return {
          kind: "error",
          exitCode: 1,
          message: `Invalid model ID: ${nextArg}`,
        };
      }

      modelId = parsedModelId;
      index += 1;
      continue;
    }

    if (arg.startsWith("--modelId=") || arg.startsWith("--model-id=")) {
      const [, rawModelId = ""] = arg.split("=", 2);
      const parsedModelId = normalizeModelId(rawModelId);

      if (!isValidModelId(parsedModelId)) {
        return {
          kind: "error",
          exitCode: 1,
          message: `Invalid model ID: ${rawModelId}`,
        };
      }

      modelId = parsedModelId;
      continue;
    }

    if (arg.startsWith("-")) {
      return {
        kind: "error",
        exitCode: 1,
        message: `Unknown option: ${arg}`,
      };
    }

    userMessageParts.push(arg);
  }

  const userMessage =
    userMessageParts.length > 0 ? userMessageParts.join(" ") : null;
  const shouldStart = command !== "chat" || userMessage !== null;

  if (print && !shouldStart) {
    return {
      kind: "error",
      exitCode: 1,
      message: "-p, --print requires a message, --init, or --update.",
    };
  }

  return {
    kind: "run",
    exitCode: 0,
    command,
    dryRun,
    modelId,
    print,
    shouldStart,
    userMessage,
  };
}

export function isDevelopmentMode(): boolean {
  return (
    process.env.NODE_ENV === "development" || process.env.OPENWIKI_DEV === "1"
  );
}

export const helpContent: HelpContent = {
  title: "OpenWiki",
  description:
    "Run a documentation agent that generates and maintains a project wiki.",
  usage: [
    "openwiki [--modelId <model>]",
    "openwiki [--modelId <model>] [message]",
    "openwiki --init [message]",
    "openwiki --update [message]",
    "openwiki login codex-oauth",
  ],
  commands: [
    {
      label: "openwiki",
      description: "Open the interactive OpenWiki chat.",
    },
    {
      label: "openwiki login codex-oauth",
      description: "Start Codex OAuth login and save tokens locally.",
    },
  ],
  options: [
    {
      label: "--init",
      description: "Generate initial OpenWiki documentation.",
    },
    {
      label: "--update",
      description: "Update existing OpenWiki documentation.",
    },
    {
      label: "-p, --print",
      description: "Run once and print the final assistant output.",
    },
    {
      label: "--modelId <id>",
      description: "Use a model ID for this run.",
    },
  ],
  developmentOptions: [
    {
      label: "--dry-run",
      description: "Show what would run without invoking the agent.",
    },
  ],
  examples: [
    "openwiki",
    "openwiki --init",
    "openwiki --update",
    'openwiki "What can you do?"',
    'openwiki -p "Summarize what OpenWiki can do"',
    "openwiki --modelId gpt-5.5",
    "openwiki login codex-oauth",
    'openwiki --update --modelId gpt-5.5 "Please document the API routes first"',
  ],
  developmentExamples: ["openwiki --dry-run"],
};

export function getHelpText(): string {
  const helpSections = [
    helpContent.title,
    `  ${helpContent.description}`,
    "",
    "Usage",
    ...helpContent.usage.map((line) => `  ${line}`),
    "",
    "Commands",
    ...formatRows(helpContent.commands),
    "",
    "Options",
    ...formatRows(helpContent.options),
    "",
  ];

  if (isDevelopmentMode()) {
    helpSections.push(
      "Development Options",
      ...formatRows(helpContent.developmentOptions),
      "",
    );
  }

  helpSections.push(
    "Examples",
    ...helpContent.examples.map((line) => `  ${line}`),
  );

  if (isDevelopmentMode()) {
    helpSections.push(
      ...helpContent.developmentExamples.map((line) => `  ${line}`),
    );
  }

  return helpSections.join("\n");
}

function formatRows(rows: HelpRow[]): string[] {
  const labelWidth = Math.max(...rows.map((row) => row.label.length));

  return rows.map(
    (row) => `  ${row.label.padEnd(labelWidth)}  ${row.description}`,
  );
}
