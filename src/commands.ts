import {
  isValidModelId,
  isValidProvider,
  normalizeModelId,
  normalizeProvider,
  type OpenWikiProvider,
} from "./constants.js";
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
      baseUrl: string | null;
      command: OpenWikiCommand;
      dryRun: boolean;
      modelId: string | null;
      print: boolean;
      provider: OpenWikiProvider | null;
      shouldStart: boolean;
      userMessage: string | null;
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

  let baseUrl: string | null = null;
  let dryRun = false;
  let modelId: string | null = null;
  let print = false;
  let provider: OpenWikiProvider | null = null;
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

    if (arg === "--modelId" || arg === "--model-id" || arg === "--model") {
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

    if (
      arg.startsWith("--modelId=") ||
      arg.startsWith("--model-id=") ||
      arg.startsWith("--model=")
    ) {
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

    if (arg === "--provider") {
      const nextArg = argv[index + 1];

      if (!nextArg || nextArg.startsWith("-")) {
        return {
          kind: "error",
          exitCode: 1,
          message: `${arg} requires a provider ID.`,
        };
      }

      const parsedProvider = normalizeProvider(nextArg);

      if (!parsedProvider || !isValidProvider(parsedProvider)) {
        return {
          kind: "error",
          exitCode: 1,
          message: `Invalid provider ID: ${nextArg}`,
        };
      }

      provider = parsedProvider;
      index += 1;
      continue;
    }

    if (arg.startsWith("--provider=")) {
      const [, rawProvider = ""] = arg.split("=", 2);
      const parsedProvider = normalizeProvider(rawProvider);

      if (!parsedProvider || !isValidProvider(parsedProvider)) {
        return {
          kind: "error",
          exitCode: 1,
          message: `Invalid provider ID: ${rawProvider}`,
        };
      }

      provider = parsedProvider;
      continue;
    }

    if (arg === "--base-url" || arg === "--baseurl") {
      const nextArg = argv[index + 1];

      if (!nextArg || nextArg.startsWith("-")) {
        return {
          kind: "error",
          exitCode: 1,
          message: `${arg} requires a URL.`,
        };
      }

      if (!isValidBaseUrl(nextArg)) {
        return {
          kind: "error",
          exitCode: 1,
          message: `Invalid base URL: ${nextArg}`,
        };
      }

      baseUrl = nextArg;
      index += 1;
      continue;
    }

    if (arg.startsWith("--base-url=") || arg.startsWith("--baseurl=")) {
      const [, rawBaseUrl = ""] = arg.split("=", 2);

      if (!isValidBaseUrl(rawBaseUrl)) {
        return {
          kind: "error",
          exitCode: 1,
          message: `Invalid base URL: ${rawBaseUrl}`,
        };
      }

      baseUrl = rawBaseUrl;
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

  if (baseUrl !== null && command !== "init") {
    return {
      kind: "error",
      exitCode: 1,
      message: "--base-url is only valid with --init.",
    };
  }

  return {
    kind: "run",
    exitCode: 0,
    baseUrl,
    command,
    dryRun,
    modelId,
    print,
    provider,
    shouldStart,
    userMessage,
  };
}

function isValidBaseUrl(value: string): boolean {
  return value.trim().length > 0 && /^https?:\/\//iu.test(value);
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
    "openwiki [--model <model>]",
    "openwiki [--model <model>] [message]",
    "openwiki --init [--provider <id>] [--base-url <url>] [--model <model>] [message]",
    "openwiki --update [message]",
  ],
  commands: [
    {
      label: "openwiki",
      description: "Open the interactive OpenWiki chat.",
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
      label: "--provider <id>",
      description: "Provider for --init (skips provider prompt).",
    },
    {
      label: "--base-url <url> / --baseurl <url>",
      description: "Base URL for --init (skips base URL prompt).",
    },
    {
      label: "--model <id>",
      description: "Use a model ID for this run (also --modelId, --model-id).",
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
    "openwiki --init --provider openai --model gpt-5.5",
    "openwiki --init --provider ollama --base-url http://localhost:11434 --model llama3.1",
    "openwiki --update",
    'openwiki "What can you do?"',
    'openwiki -p "Summarize what OpenWiki can do"',
    "openwiki --model gpt-5.5",
    'openwiki --update --model gpt-5.5 "Please document the API routes first"',
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
