import { isValidModelId, normalizeModelId } from "../config/constants.js";
import { openWikiLocalWikiDisplayPath } from "../config/openwiki-home.js";
import type { OpenWikiCommand } from "../agent/types.js";
import { resolveLanguage } from "../platform/language.js";
import { isAuthProviderId } from "../auth/providers.js";
import type { AuthProviderId } from "../auth/types.js";
import {
  parseIngestionTarget,
  type IngestionTarget,
} from "../ingestion/ingestion.js";
import {
  getHostTarget,
  listHostTargets,
} from "../integrations/install/registry.js";
import type {
  HostIntegrationScope,
  HostTargetId,
} from "../integrations/install/types.js";
import { isValidHostId } from "../integrations/core/protocol.js";

export type HelpRow = {
  label: string;
  description: string;
};

export type OpenWikiRunMode = "personal" | "code";
type CronTarget = Extract<IngestionTarget, string>;

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

/**
 * Parsed host-integration installation command.
 */
export interface IntegrationsCliCommand {
  /**
   * CLI dispatch discriminator.
   */
  kind: "integrations";

  /**
   * Registry operation requested by the user.
   */
  action: "install" | "list" | "uninstall";

  /**
   * Initial process exit code.
   */
  exitCode: 0;

  /**
   * Selected host, or `null` for the list action.
   */
  target: HostTargetId | null;

  /**
   * Ownership scope selected for the operation.
   */
  scope: HostIntegrationScope;

  /**
   * Optional project root supplied with `--project`.
   *
   * @default null - user scope is selected and the user's home is used.
   */
  projectRoot: string | null;

  /**
   * Whether install may replace unmanaged skill content.
   */
  force: boolean;
}

/**
 * Parsed internal MCP server command.
 */
export interface McpCliCommand {
  /**
   * CLI dispatch discriminator.
   */
  kind: "mcp";

  /**
   * Initial process exit code.
   */
  exitCode: 0;

  /**
   * Host identifier written to run metadata.
   */
  host: string;
}

/**
 * Host-integration commands added to the root CLI union.
 */
export type HostIntegrationCliCommand = IntegrationsCliCommand | McpCliCommand;

export type CliCommand =
  | HostIntegrationCliCommand
  | {
      kind: "auth";
      action: "configure" | "list" | "oauth" | "tools";
      exitCode: 0;
      force: boolean;
      provider: AuthProviderId | null;
    }
  | {
      kind: "ngrok";
      action: "start";
      exitCode: 0;
      port: number;
      url: string | null;
    }
  | {
      kind: "visualize";
      exitCode: 0;
      wikiDir: string;
      port: number;
      open: boolean;
      exportDir: string | null;
    }
  | {
      kind: "ingest";
      exitCode: 0;
      modelId: string | null;
      print: boolean;
      scheduledOnly: boolean;
      target: IngestionTarget;
    }
  | {
      kind: "cron";
      action: "delete" | "list" | "pause" | "resume";
      exitCode: 0;
      target: CronTarget | null;
    }
  | { kind: "help"; exitCode: 0 }
  | {
      kind: "run";
      exitCode: 0;
      command: OpenWikiCommand;
      dryRun: boolean;
      language: string | null;
      languageWarning: string | null;
      mode: OpenWikiRunMode;
      modeSource: OpenWikiRunModeSource;
      modelId: string | null;
      print: boolean;
      shouldStart: boolean;
      userMessage: string | null;
      telemetryFile: string | null;
    }
  | {
      kind: "error";
      exitCode: 1;
      message: string;
    };

export type OpenWikiRunModeSource = "default" | "option" | "positional";

export function parseCommand(argv: string[]): CliCommand {
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { kind: "help", exitCode: 0 };
  }

  if (argv[0] === "integrations") {
    return parseIntegrationsCommand(argv.slice(1));
  }

  if (argv[0] === "mcp") {
    return parseMcpCommand(argv.slice(1));
  }

  if (argv[0] === "auth") {
    const action =
      argv[1] === "configure"
        ? "configure"
        : argv[1] === "tools"
          ? "tools"
          : "oauth";
    const provider =
      action === "configure" || action === "tools"
        ? argv[2]
        : (argv[1] ?? "list");
    const optionArgs =
      action === "configure" || action === "tools"
        ? argv.slice(3)
        : argv.slice(2);
    const acceptsForce = action !== "tools";
    const unknownOption = optionArgs.find((arg) =>
      acceptsForce ? arg !== "--force" : true,
    );
    const force = acceptsForce && optionArgs.includes("--force");

    if (unknownOption) {
      return {
        kind: "error",
        exitCode: 1,
        message: `Unknown option for auth: ${unknownOption}`,
      };
    }

    if (provider === "list" && action === "oauth") {
      return {
        kind: "auth",
        action: "list",
        exitCode: 0,
        force: false,
        provider: null,
      };
    }

    if (!provider || !isAuthProviderId(provider)) {
      return {
        kind: "error",
        exitCode: 1,
        message:
          action === "configure"
            ? "Usage: openwiki auth configure <provider> [--force]"
            : action === "tools"
              ? "Usage: openwiki auth tools <provider>"
              : `Unknown auth provider: ${provider}`,
      };
    }

    return {
      kind: "auth",
      action,
      exitCode: 0,
      force,
      provider,
    };
  }

  if (argv[0] === "ngrok") {
    if (argv[1] !== "start") {
      return {
        kind: "error",
        exitCode: 1,
        message: "Usage: openwiki ngrok start [url] [--port <port>]",
      };
    }

    let port = 53682;
    let url: string | null = null;
    const optionArgs = argv.slice(2);
    for (let index = 0; index < optionArgs.length; index += 1) {
      const arg = optionArgs[index];

      if (arg === "--port") {
        const rawPort = optionArgs[index + 1];
        if (!rawPort) {
          return {
            kind: "error",
            exitCode: 1,
            message: "--port requires a value.",
          };
        }
        port = Number(rawPort);
        index += 1;
        continue;
      }

      if (arg.startsWith("--port=")) {
        port = Number(arg.slice("--port=".length));
        continue;
      }

      if (!arg.startsWith("-") && url === null) {
        url = arg;
        continue;
      }

      return {
        kind: "error",
        exitCode: 1,
        message: `Unknown option for ngrok: ${arg}`,
      };
    }

    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return {
        kind: "error",
        exitCode: 1,
        message: "--port must be between 1024 and 65535.",
      };
    }

    return {
      kind: "ngrok",
      action: "start",
      exitCode: 0,
      port,
      url,
    };
  }

  if (argv[0] === "visualize") {
    let wikiDir = "openwiki";
    let port = 4321;
    let open = true;
    let exportDir: string | null = null;
    let sawPort = false;
    let sawNoOpen = false;
    let sawPositional = false;
    const optionArgs = argv.slice(1);

    for (let index = 0; index < optionArgs.length; index += 1) {
      const arg = optionArgs[index];

      if (arg === "--no-open") {
        open = false;
        sawNoOpen = true;
        continue;
      }

      if (arg === "--port") {
        const rawPort = optionArgs[index + 1];
        if (!rawPort || rawPort.startsWith("-")) {
          return {
            kind: "error",
            exitCode: 1,
            message: "--port requires a value.",
          };
        }
        port = Number(rawPort);
        sawPort = true;
        index += 1;
        continue;
      }

      if (arg.startsWith("--port=")) {
        port = Number(arg.slice("--port=".length));
        sawPort = true;
        continue;
      }

      if (arg === "--export") {
        const outputDir = optionArgs[index + 1];
        if (!outputDir || outputDir.startsWith("-")) {
          return {
            kind: "error",
            exitCode: 1,
            message: "--export requires a directory.",
          };
        }
        exportDir = outputDir;
        index += 1;
        continue;
      }

      if (arg.startsWith("--export=")) {
        const outputDir = arg.slice("--export=".length);
        if (!outputDir) {
          return {
            kind: "error",
            exitCode: 1,
            message: "--export requires a directory.",
          };
        }
        exportDir = outputDir;
        continue;
      }

      if (!arg.startsWith("-") && !sawPositional) {
        wikiDir = arg;
        sawPositional = true;
        continue;
      }

      return {
        kind: "error",
        exitCode: 1,
        message: `Unknown option for visualize: ${arg}`,
      };
    }

    if (exportDir && (sawPort || sawNoOpen)) {
      return {
        kind: "error",
        exitCode: 1,
        message: "--export cannot be combined with --port or --no-open.",
      };
    }

    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return {
        kind: "error",
        exitCode: 1,
        message: "--port must be between 1024 and 65535.",
      };
    }

    return { kind: "visualize", exitCode: 0, wikiDir, port, open, exportDir };
  }

  if (argv[0] === "ingest") {
    const target = parseIngestionTarget(argv[1] ?? "all");
    if (!target) {
      return {
        kind: "error",
        exitCode: 1,
        message:
          "Usage: openwiki ingest <source|source-instance|all> [--scheduled] [--print] [--modelId <id>]",
      };
    }

    let modelId: string | null = null;
    let print = false;
    let scheduledOnly = false;
    const optionArgs = argv.slice(2);
    for (let index = 0; index < optionArgs.length; index += 1) {
      const arg = optionArgs[index];

      if (arg === "--print" || arg === "-p") {
        print = true;
        continue;
      }

      if (arg === "--scheduled") {
        scheduledOnly = true;
        continue;
      }

      if (arg === "--modelId" || arg === "--model-id") {
        const rawModelId = optionArgs[index + 1];
        if (!rawModelId || rawModelId.startsWith("-")) {
          return {
            kind: "error",
            exitCode: 1,
            message: `${arg} requires a model ID.`,
          };
        }

        const parsedModelId = normalizeModelId(rawModelId);
        if (!isValidModelId(parsedModelId)) {
          return {
            kind: "error",
            exitCode: 1,
            message: `Invalid model ID: ${rawModelId}`,
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

      return {
        kind: "error",
        exitCode: 1,
        message: `Unknown option for ingest: ${arg}`,
      };
    }

    return {
      kind: "ingest",
      exitCode: 0,
      modelId,
      print,
      scheduledOnly,
      target,
    };
  }

  if (argv[0] === "cron") {
    if (argv[1] === "list" && argv.length === 2) {
      return {
        kind: "cron",
        action: "list",
        exitCode: 0,
        target: null,
      };
    }

    if (argv[1] === "pause" || argv[1] === "resume" || argv[1] === "delete") {
      const target = parseIngestionTarget(argv[2] ?? "");
      if (target !== "all" || argv.length > 3) {
        return {
          kind: "error",
          exitCode: 1,
          message: `Usage: openwiki cron ${argv[1]} all`,
        };
      }

      return {
        kind: "cron",
        action: argv[1],
        exitCode: 0,
        target,
      };
    }

    {
      return {
        kind: "error",
        exitCode: 1,
        message:
          "Usage: openwiki cron list | pause all | resume all | delete all",
      };
    }
  }

  if (isOpenWikiRunMode(argv[0])) {
    return parseRunCommand(argv.slice(1), argv[0], "positional");
  }

  return parseRunCommand(argv, "code", "default");
}

/**
 * Parses one registry-driven host integration command.
 *
 * @param argv - Arguments following the `integrations` command.
 * @returns Parsed integration command or a stable CLI error.
 */
function parseIntegrationsCommand(argv: string[]): CliCommand {
  const action = argv[0];
  if (action !== "install" && action !== "list" && action !== "uninstall") {
    return integrationUsageError();
  }

  let target: HostTargetId | null = null;
  let argumentIndex = 1;
  if (action !== "list") {
    const rawTarget = argv[1];
    if (!rawTarget || rawTarget.startsWith("-")) {
      return {
        kind: "error",
        exitCode: 1,
        message: `Integration target is required. Supported targets: ${formatSupportedHostTargets()}.`,
      };
    }
    const resolvedTarget = getHostTarget(rawTarget);
    if (!resolvedTarget) {
      return {
        kind: "error",
        exitCode: 1,
        message: `Unknown integration target: ${rawTarget}. Supported targets: ${formatSupportedHostTargets()}.`,
      };
    }
    target = resolvedTarget.id;
    argumentIndex = 2;
  }

  let force = false;
  let scope: HostIntegrationScope = "user";
  let projectRoot: string | null = null;
  let sawProject = false;
  const options = argv.slice(argumentIndex);
  for (let index = 0; index < options.length; index += 1) {
    const arg = options[index];
    if (arg === "--force") {
      if (action !== "install") {
        return {
          kind: "error",
          exitCode: 1,
          message: "--force is only valid for integrations install.",
        };
      }
      if (force) {
        return {
          kind: "error",
          exitCode: 1,
          message: "--force may only be specified once.",
        };
      }
      force = true;
      continue;
    }

    if (arg === "--project" || arg.startsWith("--project=")) {
      if (sawProject) {
        return {
          kind: "error",
          exitCode: 1,
          message: "--project may only be specified once.",
        };
      }
      sawProject = true;
      scope = "project";
      if (arg.startsWith("--project=")) {
        const value = arg.slice("--project=".length);
        if (!value) {
          return {
            kind: "error",
            exitCode: 1,
            message: "--project= requires a path.",
          };
        }
        projectRoot = value;
        continue;
      }

      const value = options[index + 1];
      if (value && !value.startsWith("-")) {
        projectRoot = value;
        index += 1;
      } else {
        projectRoot = ".";
      }
      continue;
    }

    if (arg.startsWith("-")) {
      return {
        kind: "error",
        exitCode: 1,
        message: `Unknown option for integrations: ${arg}`,
      };
    }
    return {
      kind: "error",
      exitCode: 1,
      message: "Project paths must follow --project.",
    };
  }

  return {
    kind: "integrations",
    action,
    exitCode: 0,
    target,
    scope,
    projectRoot,
    force,
  };
}

/**
 * Parses the internal rootless MCP server command.
 *
 * @param argv - Arguments following the `mcp` command.
 * @returns Parsed MCP command or a stable CLI error.
 */
function parseMcpCommand(argv: string[]): CliCommand {
  let host = "unknown";
  let sawHost = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host" || arg.startsWith("--host=")) {
      if (sawHost) {
        return {
          kind: "error",
          exitCode: 1,
          message: "--host may only be specified once.",
        };
      }
      const value =
        arg === "--host" ? argv[index + 1] : arg.slice("--host=".length);
      if (!value || value.startsWith("-")) {
        return {
          kind: "error",
          exitCode: 1,
          message: "--host requires a host identifier.",
        };
      }
      if (!isValidHostId(value)) {
        return {
          kind: "error",
          exitCode: 1,
          message:
            "--host must contain 1-64 lowercase letters, digits, or hyphens.",
        };
      }
      host = value;
      sawHost = true;
      if (arg === "--host") index += 1;
      continue;
    }

    return {
      kind: "error",
      exitCode: 1,
      message: arg.startsWith("-")
        ? `Unknown option for mcp: ${arg}`
        : `Unexpected argument for mcp: ${arg}`,
    };
  }

  return { kind: "mcp", exitCode: 0, host };
}

/**
 * Builds the registry-derived integration usage error.
 *
 * @returns CLI error containing every currently supported host target.
 */
function integrationUsageError(): CliCommand {
  return {
    kind: "error",
    exitCode: 1,
    message:
      "Usage: openwiki integrations list [--project [path]] | " +
      `install <${formatSupportedHostTargets("|")}> [--force] [--project [path]] | ` +
      `uninstall <${formatSupportedHostTargets("|")}> [--project [path]]`,
  };
}

/**
 * Formats supported host IDs directly from the installation registry.
 *
 * @param separator - Text placed between host identifiers.
 * @returns Registry host IDs in stable display order.
 */
function formatSupportedHostTargets(separator = ", "): string {
  return listHostTargets()
    .map((target) => target.id)
    .join(separator);
}

function parseRunCommand(
  argv: string[],
  initialMode: OpenWikiRunMode,
  initialModeSource: OpenWikiRunModeSource,
): CliCommand {
  let dryRun = false;
  let language: string | null = null;
  let mode = initialMode;
  let modeSource = initialModeSource;
  let modelId: string | null = null;
  let print = false;
  let command: OpenWikiCommand = "chat";
  let telemetryFile: string | null = null;

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

    if (arg === "--debug") {
      // isDebugMode() reads OPENWIKI_DEBUG; setting it at parse time is the
      // least-invasive way to opt into full credential/error diagnostics.
      process.env.OPENWIKI_DEBUG = "1";
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

    if (arg === "--language" || arg === "-l") {
      const nextArg = argv[index + 1];

      if (!nextArg || nextArg.startsWith("-")) {
        return {
          kind: "error",
          exitCode: 1,
          message: `${arg} requires a locale.`,
        };
      }

      language = nextArg;
      index += 1;
      continue;
    }

    if (arg === "--mode") {
      const nextArg = argv[index + 1];

      if (!nextArg || nextArg.startsWith("-")) {
        return {
          kind: "error",
          exitCode: 1,
          message: "--mode requires personal or code.",
        };
      }

      if (!isOpenWikiRunMode(nextArg)) {
        return {
          kind: "error",
          exitCode: 1,
          message: `Invalid mode: ${nextArg}. Expected personal or code.`,
        };
      }

      const modeResult = resolveExplicitMode(mode, modeSource, nextArg);
      if (modeResult.kind === "error") {
        return modeResult;
      }

      mode = modeResult.mode;
      modeSource = "option";
      index += 1;
      continue;
    }

    if (arg.startsWith("--mode=")) {
      const [, rawMode = ""] = arg.split("=", 2);

      if (!isOpenWikiRunMode(rawMode)) {
        return {
          kind: "error",
          exitCode: 1,
          message: `Invalid mode: ${rawMode}. Expected personal or code.`,
        };
      }

      const modeResult = resolveExplicitMode(mode, modeSource, rawMode);
      if (modeResult.kind === "error") {
        return modeResult;
      }

      mode = modeResult.mode;
      modeSource = "option";
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

    if (arg === "--telemetry-file") {
      const nextArg = argv[index + 1];

      if (!nextArg || nextArg.startsWith("-")) {
        return {
          kind: "error",
          exitCode: 1,
          message: "--telemetry-file requires a path.",
        };
      }

      telemetryFile = nextArg;
      index += 1;
      continue;
    }

    if (arg.startsWith("--telemetry-file=")) {
      const [, value = ""] = arg.split("=", 2);

      if (value.length === 0) {
        return {
          kind: "error",
          exitCode: 1,
          message: "--telemetry-file requires a path.",
        };
      }

      telemetryFile = value;
      continue;
    }

    if (arg.startsWith("-")) {
      return {
        kind: "error",
        exitCode: 1,
        message: `Unknown option: ${arg}`,
      };
    }

    // A mode word in the first positional slot selects the mode even when
    // flags precede it (e.g. `openwiki --print code --update`), matching the
    // `openwiki code ...` form. Otherwise it would silently become the user
    // message and the run would target the default personal wiki.
    if (
      isOpenWikiRunMode(arg) &&
      modeSource === "default" &&
      userMessageParts.length === 0
    ) {
      mode = arg;
      modeSource = "positional";
      continue;
    }

    userMessageParts.push(arg);
  }

  const userMessage =
    userMessageParts.length > 0 ? userMessageParts.join(" ") : null;
  const shouldStart = command !== "chat" || userMessage !== null;

  // Canonicalize the requested locale here so an unrecognized value is dropped
  // (and surfaced as a warning) before it reaches the run or persisted state.
  const resolvedLanguage = resolveLanguage(language);

  if (command !== "chat" && modeSource === "default") {
    mode = "code";
  }

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
    language: resolvedLanguage.language ?? null,
    languageWarning: resolvedLanguage.warning ?? null,
    mode,
    modeSource,
    modelId,
    print,
    shouldStart,
    userMessage,
    telemetryFile,
  };
}

function resolveExplicitMode(
  currentMode: OpenWikiRunMode,
  modeSource: OpenWikiRunModeSource,
  nextMode: OpenWikiRunMode,
):
  | { kind: "ok"; mode: OpenWikiRunMode }
  | { kind: "error"; exitCode: 1; message: string } {
  if (currentMode === nextMode || modeSource === "default") {
    return { kind: "ok", mode: nextMode };
  }

  return {
    kind: "error",
    exitCode: 1,
    message: `Conflicting modes: ${currentMode} and ${nextMode}.`,
  };
}

function isOpenWikiRunMode(
  value: string | undefined,
): value is OpenWikiRunMode {
  return value === "personal" || value === "code";
}

/**
 * True when a run must bypass the Ink UI and use the non-interactive path:
 * either the user asked for print mode, or stdin is not a TTY (CI, cron,
 * pipes), where Ink's raw-mode input is unavailable and rendering the UI
 * fails. Interactive chat without a message still requires a TTY, so it is
 * excluded.
 */
export function shouldRunNonInteractively(
  command: CliCommand,
  stdinIsTTY: boolean,
): command is Extract<CliCommand, { kind: "run" }> {
  return (
    command.kind === "run" &&
    !command.dryRun &&
    (command.print || (!stdinIsTTY && command.shouldStart))
  );
}

export function isDevelopmentMode(): boolean {
  return (
    process.env.NODE_ENV === "development" || process.env.OPENWIKI_DEV === "1"
  );
}

/**
 * True for commands that send telemetry and therefore require the one-time
 * disclosure. Only init/update runs emit the single openwiki_run event; chat,
 * auth, and ingest record nothing, so those sessions need no disclosure.
 */
export function commandEmitsTelemetry(command: CliCommand): boolean {
  return (
    command.kind === "run" &&
    !command.dryRun &&
    (command.command === "init" || command.command === "update")
  );
}

/**
 * True when a command needs credentials from OpenWiki's private environment.
 * Host integration and MCP commands deliberately use the host's authenticated
 * session and never load OpenWiki model credentials.
 *
 * @param command - Parsed command to inspect.
 * @returns Whether the CLI should load the OpenWiki environment.
 */
export function commandLoadsEnvironment(command: CliCommand): boolean {
  return (
    (command.kind === "run" && !command.dryRun) ||
    command.kind === "auth" ||
    command.kind === "cron" ||
    command.kind === "ingest" ||
    command.kind === "ngrok"
  );
}

export const helpContent: HelpContent = {
  title: "OpenWiki",
  description:
    "Run an agent that generates and maintains a project or local knowledge wiki.",
  usage: [
    "openwiki [--init|--update] [message]",
    "openwiki code [--init|--update] [message]",
    "openwiki personal [--init|--update] [message]",
    "openwiki --mode <personal|code> [--init|--update] [message]",
    "openwiki [--language <locale>] [--init|--update] [message]",
    "openwiki [--modelId <model>]",
    "openwiki [--modelId <model>] [message]",
    "openwiki --update [message]",
    "openwiki auth <provider>",
    "openwiki auth configure <provider> [--force]",
    "openwiki auth tools <provider>",
    "openwiki ingest <source|source-instance|all> [--scheduled] [--print] [--modelId <id>]",
    "openwiki cron list",
    "openwiki cron pause all",
    "openwiki cron resume all",
    "openwiki cron delete all",
    "openwiki ngrok start [url] [--port <port>]",
    "openwiki visualize [path] [--port <port>] [--no-open] [--export <dir>]",
    "openwiki integrations list [--project [path]]",
    `openwiki integrations install <${formatSupportedHostTargets("|")}> [--force] [--project [path]]`,
    `openwiki integrations uninstall <${formatSupportedHostTargets("|")}> [--project [path]]`,
  ],
  commands: [
    {
      label: "openwiki code",
      description:
        "Run OpenWiki for the current repository, writing docs under repo openwiki/ and using GitHub Actions for recurrence.",
    },
    {
      label: "openwiki personal",
      description: `Run OpenWiki as your local personal brain over configured sources, writing to ${openWikiLocalWikiDisplayPath}.`,
    },
    {
      label: "openwiki",
      description:
        "Open the interactive OpenWiki code chat for the current repository.",
    },
    {
      label: "openwiki auth <provider>",
      description:
        "Authenticate, create connector config, and discover MCP tools when available.",
    },
    {
      label: "openwiki auth configure <provider>",
      description:
        "Create local connector config that references saved auth env vars.",
    },
    {
      label: "openwiki auth tools <provider>",
      description: "List available MCP tools for a configured auth provider.",
    },
    {
      label: "openwiki ingest <source|source-instance|all>",
      description:
        "Run ingestion and wiki update runs for one connector, one source instance, or all configured sources.",
    },
    {
      label: "openwiki cron list",
      description: "List saved connector schedules and local launchd status.",
    },
    {
      label: "openwiki cron pause all",
      description:
        "Pause saved connector schedules and reconcile the Mac wake window.",
    },
    {
      label: "openwiki cron resume all",
      description:
        "Resume paused connector schedules and reconcile the Mac wake window.",
    },
    {
      label: "openwiki cron delete all",
      description:
        "Delete saved connector schedules and remove stale local schedule files.",
    },
    {
      label: "openwiki ngrok start [url]",
      description:
        "Start an ngrok tunnel for Slack OAuth, optionally using a fixed HTTPS URL.",
    },
    {
      label: "openwiki visualize [path] [--export <dir>]",
      description:
        "Serve a live graph and reader, or export a static graph for web hosting (defaults to ./openwiki).",
    },
    {
      label: "openwiki integrations list [--project [path]]",
      description:
        "Show user-level OpenWiki installation status, or project status with --project.",
    },
    {
      label: "openwiki integrations install <host> [--project [path]]",
      description:
        "Install the OpenWiki skill and MCP config globally, or into one project with --project.",
    },
    {
      label: "openwiki integrations uninstall <host> [--project [path]]",
      description:
        "Safely remove a global integration, or a project integration with --project.",
    },
  ],
  options: [
    {
      label: "--init",
      description:
        "Generate repository documentation from scratch, replacing an existing generated wiki while preserving openwiki/INSTRUCTIONS.md. Defaults to code mode; use personal to initialize the local personal brain.",
    },
    {
      label: "--update",
      description:
        "Update existing OpenWiki documentation. Defaults to code mode; use personal to update the local personal brain.",
    },
    {
      label: "--mode <personal|code>",
      description:
        "Choose the personal brain (local, over configured sources) or the code brain (repository docs).",
    },
    {
      label: "-l, --language <locale>",
      description:
        "Generate wiki documentation in the requested language or locale.",
    },
    {
      label: "-p, --print",
      description: "Run once and print the final assistant output.",
    },
    {
      label: "--debug",
      description:
        "Show full credential and error diagnostics when a run fails.",
    },
    {
      label: "--modelId <id>",
      description: "Use a model ID for this run.",
    },
    {
      label: "--scheduled",
      description:
        "For ingest only: run scheduled-only ingestion for scheduler-managed runs.",
    },
    {
      label: "--telemetry-file <path>",
      description:
        "Write the exact anonymous telemetry payload to a local JSON file.",
    },
    {
      label: "--port <port>",
      description:
        "For visualize: port to serve on (default 4321; increments on conflict).",
    },
    {
      label: "--no-open",
      description: "For visualize: do not open the browser automatically.",
    },
    {
      label: "--export <dir>",
      description:
        "For visualize: write a static visualizer directory instead of starting the local server.",
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
    "openwiki personal --init",
    "openwiki code --init",
    "openwiki --update",
    "openwiki --update --mode personal",
    'openwiki "What can you do?"',
    'openwiki -p "Summarize what OpenWiki can do"',
    "openwiki --modelId gpt-5.5",
    'openwiki --update --modelId gpt-5.5 "Please document the API routes first"',
    'openwiki personal --update "Refresh the wiki from configured connectors"',
    "openwiki ingest all",
    "openwiki ingest all --scheduled --print",
    "openwiki ingest web-search",
    "openwiki ingest web-search-2",
    "openwiki cron list",
    "openwiki cron pause all",
    "openwiki cron resume all",
    "openwiki cron delete all",
    "openwiki auth slack",
    "openwiki auth gmail",
    "openwiki auth notion",
    "openwiki auth tools notion",
    "openwiki ngrok start",
    "openwiki ngrok start https://openwiki.ngrok.app",
    "openwiki visualize",
    "openwiki visualize openwiki --port 4400 --no-open",
    "openwiki visualize openwiki --export docs/openwiki-visualizer",
    "openwiki integrations list",
    "openwiki integrations install codex",
    "openwiki integrations uninstall codex",
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
