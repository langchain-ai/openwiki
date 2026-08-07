#!/usr/bin/env node
import path from "node:path";
import { scheduler } from "node:timers/promises";
import React, { useEffect, useRef, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import { marked, type Token, type Tokens } from "marked";
import {
  configureAuthProvider,
  listAuthProviderTools,
  shouldDiscoverToolsAfterAuth,
} from "../auth/configure.js";
import { startNgrokTunnel } from "../auth/ngrok.js";
import { runVisualizeServer } from "../visualize/server.js";
import { formatAuthProviderList, runOAuthAuth } from "../auth/oauth.js";
import {
  ensureCodeModeRepoSetup,
  runCodeModeConnectors,
} from "../ingestion/code-mode.js";
import {
  commandEmitsTelemetry,
  helpContent,
  isDevelopmentMode,
  parseCommand,
  shouldRunNonInteractively,
  type CliCommand,
  type HelpRow,
  type OpenWikiRunMode,
} from "./commands.js";
import { resolveStartupCommand } from "./startup.js";
import { isDebugMode, shouldShowCredentialDiagnostics } from "./debug.js";
import {
  getAuthFix,
  getAuthFixSteps,
  type AuthFix,
} from "./diagnostics/auth-fix.js";
import {
  getErrorDiagnostics,
  type ErrorDiagnostic,
} from "./diagnostics/error-diagnostics.js";
import { sanitizeHeaderValue } from "./diagnostics/sanitize.js";
import type {
  ChatInputMenuState,
  ChatInputState,
  SecretInputMode,
  SlashCommandOption,
} from "./input/types.js";
import {
  applyRawInputValue,
  deleteAtInputCursor,
  deleteBeforeInputCursor,
  isEscapeInput,
  isRawBackspaceInput,
  moveInputCursor,
} from "./input/cursor.js";
import {
  getCurrentModelOptionIndex,
  getCurrentProviderOptionIndex,
  getModelMenuOptions,
  isMenuDownInput,
  isMenuUpInput,
  moveMenuSelection,
  parseSlashInput,
  slashCommandOptions,
  syncMenuStateForInput,
} from "./input/menu.js";
import { formatSecretInputSummary } from "./input/secret.js";
import type { RunLogItem } from "./run-log/types.js";
import { appendRunLogEvent } from "./run-log/reducer.js";
import {
  formatCwd,
  getDisplayModelId,
  getSpinnerFrame,
  isExitMessage,
  truncateLogOutput,
} from "./format.js";
import {
  formatPowerScheduleStatus,
  formatScheduleHeader,
  formatScheduleMutationResult,
  formatScheduleStatus,
} from "./schedule-format.js";
import {
  getRunModeCwd,
  getRunModeOutputMode,
  shouldAutoExitStartupRun,
  shouldPrintStartupError,
} from "./run-mode.js";
import {
  InitSetup,
  needsCredentialSetup,
  type InitSetupResult,
} from "../setup/credentials.js";
import {
  getCredentialDiagnostics,
  loadOpenWikiEnv,
  saveOpenWikiEnv,
  type CredentialDiagnostic,
} from "../config/env.js";
import { createOpenWikiThreadId, runOpenWikiAgent } from "../agent/index.js";
import { installCrashGuard } from "../agent/crash-guard.js";
import { formatChatGptAccountFromEnv } from "../agent/openai-chatgpt-oauth.js";
import { getErrorMessage } from "../platform/diagnostics.js";
import { stripHtmlTags } from "../platform/utils.js";
import {
  type OpenWikiRunEvent,
  type OpenWikiRunResult,
} from "../agent/types.js";
import {
  runOpenWikiIngestion,
  type OpenWikiIngestionResult,
} from "../ingestion/ingestion.js";
import {
  readOpenWikiOnboardingConfig,
  saveOpenWikiOnboardingConfig,
} from "../setup/onboarding.js";
import {
  deleteConnectorSchedules,
  getSavedPowerScheduleStatus,
  listConnectorSchedules,
  pauseConnectorSchedules,
  resumeConnectorSchedules,
} from "../scheduling/schedules.js";
import {
  getDefaultModelId,
  getMissingProviderEnvKey,
  getProviderApiKeyEnvKey,
  getProviderCredentialHint,
  getProviderLabel,
  getProviderModelOptions,
  getProviderProjectEnvKey,
  isValidModelId,
  normalizeModelId,
  normalizeProvider,
  OPENWIKI_PROVIDER_ENV_KEY,
  OPENWIKI_MODEL_ID_ENV_KEY,
  providerUsesAwsSdkCredentials,
  resolveConfiguredProvider,
  SELECTABLE_OPENWIKI_PROVIDERS,
  OPENWIKI_VERSION,
  type OpenWikiProvider,
} from "../config/constants.js";
import type { OpenWikiCommand, OpenWikiRunOptions } from "../agent/types.js";
import {
  firstRunNoticePending,
  FIRST_RUN_NOTICE_BODY,
  FIRST_RUN_NOTICE_OPT_OUT,
  FIRST_RUN_NOTICE_VERIFY,
  withRunTelemetry,
  type RunTelemetryContext,
} from "../telemetry/index.js";

// Register the last-resort handlers before any run starts, so a rejection that
// escapes every catch (e.g. a subagent error surfacing on the microtask queue) is
// recorded and stamped instead of hard-killing the process with no telemetry.
installCrashGuard();

type RunState =
  | { status: "idle" }
  | { status: "setup-complete-exit"; result: InitSetupResult }
  | { status: "init-setup-saved"; result: InitSetupResult }
  | {
      status: "ingestion-running";
      log: RunLogItem[];
      credentialDiagnostics?: CredentialDiagnostic[];
    }
  | {
      status: "ingestion-success";
      result: OpenWikiIngestionResult;
      log: RunLogItem[];
      credentialDiagnostics?: CredentialDiagnostic[];
    }
  | {
      status: "running";
      command: OpenWikiCommand;
      log: RunLogItem[];
      credentialDiagnostics?: CredentialDiagnostic[];
    }
  | {
      status: "success";
      result: OpenWikiRunResult;
      log: RunLogItem[];
      credentialDiagnostics?: CredentialDiagnostic[];
    }
  | {
      status: "error";
      message: string;
      credentialDiagnostics?: CredentialDiagnostic[];
      errorDiagnostics?: ErrorDiagnostic[];
      authFix?: AuthFix;
    };

type CompletedRun = {
  id: number;
  command: OpenWikiCommand;
  credentialDiagnostics?: CredentialDiagnostic[];
  log: RunLogItem[];
  message: string | null;
  result: OpenWikiRunResult;
};

type AppProps = {
  command: CliCommand;
};

const OPENWIKI_LOGO_LINES = [
  "  ___                  __        ___ _    _ ",
  " / _ \\ _ __   ___ _ __ \\ \\      / (_) | _(_)",
  "| | | | '_ \\ / _ \\ '_ \\ \\ \\ /\\ / /| | |/ / |",
  "| |_| | |_) |  __/ | | | \\ V  V / | |   <| |",
  " \\___/| .__/ \\___|_| |_|  \\_/\\_/  |_|_|\\_\\_|",
  "      |_|",
];
const OPENWIKI_LOGO_WIDTH = Math.max(
  ...OPENWIKI_LOGO_LINES.map((line) => line.length),
);

/** Frame/wrap width for the plain-text (print/non-TTY) first-run disclosure. */
const FIRST_RUN_NOTICE_WIDTH = 64;

/** Greedy word-wrap to `width` columns. Input carries no existing newlines. */
function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";

  for (const word of text.split(/\s+/)) {
    if (line.length === 0) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) {
    lines.push(line);
  }

  return lines;
}

/**
 * The plain-text first-run disclosure for print/non-TTY output: the same copy as
 * the interactive box (single-sourced in telemetry/config.ts), framed with light
 * rules and wrapped to a fixed width. Rendered gray when stderr is a TTY, plain
 * when redirected so a captured log stays free of escape codes.
 */
function renderFirstRunNoticeText(color: boolean): string {
  const label = "OpenWiki telemetry";
  const width = FIRST_RUN_NOTICE_WIDTH;
  const topRule = `─── ${label} ${"─".repeat(Math.max(3, width - label.length - 5))}`;
  const block = [
    "",
    topRule,
    "",
    ...wrapText(FIRST_RUN_NOTICE_BODY, width),
    "",
    ...wrapText(FIRST_RUN_NOTICE_OPT_OUT, width),
    "",
    ...wrapText(FIRST_RUN_NOTICE_VERIFY, width),
    "─".repeat(width),
    "",
  ].join("\n");

  return color ? `\u001b[90m${block}\u001b[39m` : block;
}

/**
 * The one-time telemetry disclosure, rendered as a box so it sits inline with
 * the rest of the TUI (mirrors SetupHeader's rounded style). The copy is
 * single-sourced in telemetry/config.ts; the print/non-TTY path renders the
 * same wording as plain text via renderFirstRunNoticeText.
 */
function FirstRunNotice() {
  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      marginBottom={1}
      paddingX={1}
    >
      <Text>
        <Text bold color="cyan">
          OpenWiki
        </Text>{" "}
        <Text color="gray">telemetry</Text>
      </Text>
      <Text color="white">{FIRST_RUN_NOTICE_BODY}</Text>
      <Text color="white">{FIRST_RUN_NOTICE_OPT_OUT}</Text>
      <Text color="white">{FIRST_RUN_NOTICE_VERIFY}</Text>
    </Box>
  );
}

function App({ command }: AppProps) {
  const app = useApp();
  const startupModelId = command.kind === "run" ? command.modelId : null;
  const startupRunMode = command.kind === "run" ? command.mode : "personal";
  const [runMode, setRunMode] = useState<OpenWikiRunMode>(startupRunMode);
  const [codeRuntimeCwd, setCodeRuntimeCwd] = useState(process.cwd());
  const runtimeCwd = getRunModeCwd(runMode, codeRuntimeCwd);
  const runtimeOutputMode = getRunModeOutputMode(runMode);
  const startupProvider = resolveConfiguredProvider();
  const autoExitOnSuccess = shouldAutoExitStartupRun(command);
  const [sessionProvider, setSessionProvider] =
    useState<OpenWikiProvider>(startupProvider);
  const [sessionModelId, setSessionModelId] = useState<string | null>(
    startupModelId,
  );
  const activeRunId = useRef(0);
  const agentRunInFlight = useRef(false);
  const sessionThreadId = useRef(createOpenWikiThreadId(runtimeCwd));
  const sessionThreadMode = useRef<OpenWikiRunMode>(runMode);
  const mountedRef = useRef(false);
  const nextLogId = useRef(1);
  const nextCompletedRunId = useRef(1);
  const activeRunCredentialDiagnostics = useRef<
    CredentialDiagnostic[] | undefined
  >(undefined);
  const activeRunLog = useRef<RunLogItem[]>([]);
  const [runState, setRunState] = useState<RunState>({ status: "idle" });
  const [completedRuns, setCompletedRuns] = useState<CompletedRun[]>([]);
  const [activeUserMessage, setActiveUserMessage] = useState<string | null>(
    command.kind === "run" ? command.userMessage : null,
  );
  const [activeMessageIsFollowup, setActiveMessageIsFollowup] = useState(
    command.kind === "run" && command.command === "chat",
  );
  const shouldOpenSetupForExplicitModeChat =
    command.kind === "run" &&
    !command.dryRun &&
    !command.shouldStart &&
    command.modeSource !== "default" &&
    process.stdin.isTTY &&
    needsCredentialSetup(sessionModelId, runMode);
  const [resolvedCommand, setResolvedCommand] =
    useState<OpenWikiCommand | null>(
      command.kind === "run" &&
        (command.shouldStart || shouldOpenSetupForExplicitModeChat)
        ? command.command
        : null,
    );
  // `--init` always opens the full setup walk, even when everything is already
  // configured, so you can review or change any step. Consumed once the walk
  // finishes so it does not re-open when the run later returns to idle.
  const [initWizardConsumed, setInitWizardConsumed] = useState(false);
  const isInitCommand = command.kind === "run" && command.command === "init";
  const shouldRunInteractiveCredentialSetup =
    command.kind === "run" &&
    resolvedCommand !== null &&
    !command.dryRun &&
    process.stdin.isTTY &&
    runState.status === "idle" &&
    (needsCredentialSetup(sessionModelId, runMode) ||
      (isInitCommand && !initWizardConsumed));
  const displayModelId = sessionModelId ?? startupModelId;

  function submitChatMessage(message: string) {
    if (isExitMessage(message)) {
      process.exitCode = 0;
      app.exit();
      return;
    }

    setActiveUserMessage(message);
    setActiveMessageIsFollowup(true);
    setResolvedCommand("chat");
    setRunState({ status: "idle" });
  }

  function submitCommandRun(
    nextCommand: Extract<OpenWikiCommand, "init" | "update">,
    message: string | null,
  ) {
    setActiveUserMessage(message);
    setActiveMessageIsFollowup(false);
    setResolvedCommand(nextCommand);
    setRunState({ status: "idle" });
  }

  function startIngestionRun(modelId: string | null) {
    const runId = activeRunId.current + 1;
    activeRunId.current = runId;
    activeRunCredentialDiagnostics.current = undefined;
    activeRunLog.current = [];
    setResolvedCommand(null);
    setActiveUserMessage(
      "Run source-specific OpenWiki ingestion for configured sources.",
    );
    setActiveMessageIsFollowup(false);
    setRunState({
      status: "ingestion-running",
      log: [],
    });

    void runOpenWikiIngestion(process.cwd(), {
      debug: isDebugMode(),
      modelId,
      target: "all",
      onEvent: (event) => {
        if (!mountedRef.current || activeRunId.current !== runId) {
          return;
        }

        activeRunLog.current = appendRunLogEvent(
          activeRunLog.current,
          event,
          nextLogId,
        );
        setRunState((currentState) =>
          currentState.status === "ingestion-running"
            ? {
                ...currentState,
                log: activeRunLog.current,
              }
            : currentState,
        );
      },
    })
      .then((result) => {
        if (!mountedRef.current || activeRunId.current !== runId) {
          return;
        }

        if (
          result.results.some((sourceResult) => sourceResult.status === "error")
        ) {
          process.exitCode = 1;
        }

        setRunState({
          status: "ingestion-success",
          result,
          log: activeRunLog.current,
          credentialDiagnostics: activeRunCredentialDiagnostics.current,
        });
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || activeRunId.current !== runId) {
          return;
        }

        const errorDiagnostics = getErrorDiagnostics(error);
        const message = getErrorMessage(error);
        const authFix = getAuthFix(error, message, sessionProvider);

        // The full credential dump is opt-in (--debug); by default show only the
        // concise message, allowlisted error fields, and the how-to-fix panel.
        if (!shouldShowCredentialDiagnostics()) {
          setRunState({
            status: "error",
            message,
            errorDiagnostics,
            authFix,
          });
          return;
        }

        void getCredentialDiagnostics()
          .catch(() => undefined)
          .then((credentialDiagnostics) => {
            if (!mountedRef.current || activeRunId.current !== runId) {
              return;
            }

            setRunState({
              status: "error",
              message,
              credentialDiagnostics,
              errorDiagnostics,
              authFix,
            });
          });
      });
  }

  function clearSession() {
    activeRunId.current += 1;
    sessionThreadId.current = createOpenWikiThreadId(runtimeCwd);
    activeRunCredentialDiagnostics.current = undefined;
    activeRunLog.current = [];
    nextLogId.current = 1;
    nextCompletedRunId.current = 1;
    setCompletedRuns([]);
    setActiveUserMessage(null);
    setActiveMessageIsFollowup(false);
    setResolvedCommand(null);
    setRunState({ status: "idle" });
  }

  async function selectModel(modelId: string) {
    await saveOpenWikiEnv({
      [OPENWIKI_MODEL_ID_ENV_KEY]: modelId,
    });
    setSessionModelId(modelId);
  }

  async function selectProvider(provider: OpenWikiProvider) {
    const modelId =
      getProviderModelOptions(provider).length > 0
        ? getDefaultModelId(provider)
        : null;

    await saveOpenWikiEnv({
      [OPENWIKI_PROVIDER_ENV_KEY]: provider,
      ...(modelId ? { [OPENWIKI_MODEL_ID_ENV_KEY]: modelId } : {}),
    });
    setSessionProvider(provider);
    setSessionModelId(modelId);
  }

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (sessionThreadMode.current === runMode) {
      return;
    }

    sessionThreadId.current = createOpenWikiThreadId(runtimeCwd);
    sessionThreadMode.current = runMode;
  }, [runMode, runtimeCwd]);

  useEffect(() => {
    if (command.kind === "help" || command.kind === "error") {
      process.exitCode = command.exitCode;
      app.exit();
      return;
    }

    if (command.kind === "auth") {
      process.exitCode = command.exitCode;
      app.exit();
      return;
    }

    if (command.kind === "run" && command.dryRun) {
      process.exitCode = 0;
      app.exit();
      return;
    }

    if (command.kind !== "run") {
      return;
    }

    if (resolvedCommand === null) {
      return;
    }

    const missingEnvKey = getMissingProviderEnvKey(sessionProvider);

    if (missingEnvKey && !process.stdin.isTTY) {
      const hint = getProviderCredentialHint(sessionProvider);

      setRunState({
        status: "error",
        message: `${missingEnvKey} is required. Run openwiki in an interactive terminal to save credentials.${
          hint ? ` ${hint}` : ""
        }`,
      });
      return;
    }

    if (shouldRunInteractiveCredentialSetup) {
      return;
    }

    if (isInitCommand && initWizardConsumed && runState.status === "idle") {
      return;
    }

    if (runState.status !== "idle" && runState.status !== "init-setup-saved") {
      return;
    }

    if (agentRunInFlight.current) {
      return;
    }
    agentRunInFlight.current = true;

    const runId = activeRunId.current + 1;
    const runMessage = activeUserMessage;

    activeRunId.current = runId;
    activeRunCredentialDiagnostics.current = undefined;
    activeRunLog.current = [];
    setRunState({
      status: "running",
      command: resolvedCommand,
      log: [],
    });

    if (shouldShowCredentialDiagnostics()) {
      void getCredentialDiagnostics()
        .catch(() => undefined)
        .then((credentialDiagnostics) => {
          if (
            !mountedRef.current ||
            activeRunId.current !== runId ||
            !credentialDiagnostics
          ) {
            return;
          }

          setRunState((currentState) =>
            updateRunningCredentialDiagnostics(
              currentState,
              credentialDiagnostics,
              activeRunCredentialDiagnostics,
            ),
          );
        });
    }

    const handleRunEvent = (event: OpenWikiRunEvent): void => {
      if (!mountedRef.current || activeRunId.current !== runId) {
        return;
      }

      activeRunLog.current = appendRunLogEvent(
        activeRunLog.current,
        event,
        nextLogId,
      );
      setRunState((currentState) =>
        currentState.status === "running"
          ? {
              ...currentState,
              log: activeRunLog.current,
            }
          : currentState,
      );
    };

    const runOptions: OpenWikiRunOptions = {
      debug: isDebugMode(),
      isFollowup: activeMessageIsFollowup,
      language: command.language,
      modelId: sessionModelId,
      outputMode: runtimeOutputMode,
      threadId: sessionThreadId.current,
      telemetryFile: command.telemetryFile ?? undefined,
      onEvent: handleRunEvent,
    };

    // withRunTelemetry is the single boundary that records this run. It wraps repo
    // setup and the connector pull too (not just the agent), so a throw in either
    // pre-agent step is recorded rather than reaching only the UI catch below.
    const telemetryContext: RunTelemetryContext = {};

    withRunTelemetry(
      resolvedCommand,
      runOptions,
      telemetryContext,
      async () => {
        if (runMode === "code") {
          await ensureCodeModeRepoSetup(runtimeCwd, {
            createWorkflow: resolvedCommand === "init",
          });
        }

        await scheduler.yield();

        // Code-mode connectors pull their evidence and augment the agent message
        // before the run, matching the --print path exactly. They emit progress
        // into the same run log so the pull is visible rather than a silent gap.
        const userMessage =
          runMode === "code" && resolvedCommand !== "chat"
            ? await runCodeModeConnectors(
                runtimeCwd,
                activeUserMessage ?? undefined,
                handleRunEvent,
              )
            : activeUserMessage;

        return runOpenWikiAgent(
          resolvedCommand,
          runtimeCwd,
          { ...runOptions, userMessage },
          telemetryContext,
        );
      },
    )
      .then((result) => {
        if (!mountedRef.current || activeRunId.current !== runId) {
          return;
        }

        setRunState({
          status: "success",
          result,
          log: activeRunLog.current,
          credentialDiagnostics: activeRunCredentialDiagnostics.current,
        });
        setCompletedRuns((runs) => [
          ...runs,
          {
            id: nextCompletedRunId.current,
            command: result.command,
            credentialDiagnostics: activeRunCredentialDiagnostics.current,
            log: activeRunLog.current,
            message: runMessage,
            result,
          },
        ]);
        nextCompletedRunId.current += 1;
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || activeRunId.current !== runId) {
          return;
        }

        const errorDiagnostics = getErrorDiagnostics(error);
        const message = getErrorMessage(error);
        const authFix = getAuthFix(error, message, sessionProvider);

        // The full credential dump is opt-in (--debug); by default show only the
        // concise message, allowlisted error fields, and the how-to-fix panel.
        if (!shouldShowCredentialDiagnostics()) {
          setRunState({
            status: "error",
            message,
            errorDiagnostics,
            authFix,
          });
          return;
        }

        void getCredentialDiagnostics()
          .catch(() => undefined)
          .then((credentialDiagnostics) => {
            if (!mountedRef.current || activeRunId.current !== runId) {
              return;
            }

            setRunState({
              status: "error",
              message,
              credentialDiagnostics,
              errorDiagnostics,
              authFix,
            });
          });
      })
      .finally(() => {
        agentRunInFlight.current = false;
      });
  }, [
    app,
    command,
    activeMessageIsFollowup,
    activeUserMessage,
    initWizardConsumed,
    isInitCommand,
    resolvedCommand,
    runMode,
    runState.status,
    runtimeCwd,
    runtimeOutputMode,
    sessionModelId,
    sessionProvider,
    shouldRunInteractiveCredentialSetup,
  ]);

  useEffect(() => {
    if (runState.status === "error") {
      process.exitCode = 1;
      app.exit();
      return;
    }

    if (runState.status === "success" && autoExitOnSuccess) {
      process.exitCode = 0;
      app.exit();
      return;
    }

    if (runState.status === "ingestion-success" && autoExitOnSuccess) {
      process.exitCode = runState.result.results.some(
        (sourceResult) => sourceResult.status === "error",
      )
        ? 1
        : 0;
      app.exit();
    }
  }, [app, autoExitOnSuccess, runState]);

  if (command.kind === "help") {
    return <HelpView />;
  }

  if (command.kind === "error") {
    return (
      <Box flexDirection="column">
        <Header modelId={null} subtitle="Command failed" />
        <StatusLine tone="error" label="Error" value={command.message} />
        <HelpView />
      </Box>
    );
  }

  if (command.kind === "run" && command.dryRun) {
    return (
      <DryRunView
        command={command.command}
        modelId={command.modelId}
        shouldStart={command.shouldStart}
        userMessage={command.userMessage}
      />
    );
  }

  if (shouldRunInteractiveCredentialSetup) {
    return (
      <InitSetup
        allowModeSelection={false}
        mode={command.mode}
        modelIdOverride={command.modelId}
        walkAllSteps={isInitCommand}
        onComplete={(result) => {
          if (agentRunInFlight.current) {
            return;
          }

          setInitWizardConsumed(true);
          const nextCodeRuntimeCwd = result.repoRoot ?? codeRuntimeCwd;

          if (result.repoRoot) {
            setCodeRuntimeCwd(result.repoRoot);
          }

          if (result.mode !== runMode) {
            const nextRuntimeCwd = getRunModeCwd(
              result.mode,
              nextCodeRuntimeCwd,
            );
            sessionThreadId.current = createOpenWikiThreadId(nextRuntimeCwd);
            sessionThreadMode.current = result.mode;
            setRunMode(result.mode);
          } else if (result.repoRoot) {
            sessionThreadId.current = createOpenWikiThreadId(result.repoRoot);
            sessionThreadMode.current = result.mode;
          }

          if (result.modelId) {
            setSessionModelId(result.modelId);
          }
          if (result.provider) {
            setSessionProvider(result.provider);
          }

          if (!result.shouldContinueToRun) {
            activeRunId.current += 1;
            setResolvedCommand(null);
            setActiveUserMessage(null);
            setActiveMessageIsFollowup(false);
            setRunState({ status: "idle" });
            return;
          }

          if (result.runIngestionNow && result.mode === "code") {
            if (command.kind === "run" && !command.shouldStart) {
              setResolvedCommand("init");
            }
            setActiveMessageIsFollowup(false);
            setRunState({ status: "init-setup-saved", result });
            return;
          }

          if (result.runIngestionNow) {
            startIngestionRun(result.modelId ?? sessionModelId);
            return;
          }

          setRunState({ status: "init-setup-saved", result });
        }}
        onError={(message) => {
          setRunState({ status: "error", message });
        }}
      />
    );
  }

  if (runState.status === "init-setup-saved") {
    return (
      <Box flexDirection="column">
        <Header
          modelId={runState.result.modelId ?? displayModelId}
          subtitle="Credential setup"
        />
        {runState.result.savedApiKey ||
        runState.result.savedProvider ||
        runState.result.savedBaseUrl ||
        runState.result.savedRegion ||
        runState.result.savedSecretKey ||
        runState.result.savedGcpProject ||
        runState.result.savedGcpLocation ||
        runState.result.savedModelId ||
        runState.result.savedLangSmithKey ? (
          <StatusLine tone="success" label="Credentials" value="saved" />
        ) : null}
        {runState.result.provider ? (
          <StatusLine
            tone="muted"
            label="Provider"
            value={getProviderLabel(runState.result.provider)}
          />
        ) : null}
        {runState.result.modelId ? (
          <StatusLine
            tone="muted"
            label="Model"
            value={runState.result.modelId}
          />
        ) : null}
        <StatusLine tone="active" label="Next" value="starting openwiki" />
      </Box>
    );
  }

  if (runState.status === "setup-complete-exit") {
    return (
      <Box flexDirection="column">
        <Header
          modelId={runState.result.modelId ?? displayModelId}
          subtitle="Setup complete"
        />
        <StatusLine
          tone="success"
          label="Setup"
          value="saved; waiting for scheduled ingestion"
        />
      </Box>
    );
  }

  if (runState.status === "running") {
    return (
      <Box flexDirection="column">
        <ChatHistory runs={completedRuns} />
        <RunView
          command={runState.command}
          credentialDiagnostics={runState.credentialDiagnostics}
          log={runState.log}
          message={activeUserMessage}
          modelId={displayModelId}
        />
      </Box>
    );
  }

  if (runState.status === "ingestion-running") {
    return (
      <Box flexDirection="column">
        <ChatHistory runs={completedRuns} />
        <RunView
          command="update"
          credentialDiagnostics={runState.credentialDiagnostics}
          log={runState.log}
          message={activeUserMessage}
          modelId={displayModelId}
        />
      </Box>
    );
  }

  if (runState.status === "ingestion-success") {
    return (
      <Box flexDirection="column">
        <Header modelId={displayModelId} subtitle="Ingestion complete" />
        <IngestionSummary result={runState.result} />
        <RunView
          command="update"
          credentialDiagnostics={runState.credentialDiagnostics}
          done
          log={runState.log}
          message={activeUserMessage}
          modelId={displayModelId}
        />
      </Box>
    );
  }

  if (runState.status === "success") {
    if (autoExitOnSuccess) {
      return (
        <RunView
          command={runState.result.command}
          credentialDiagnostics={runState.credentialDiagnostics}
          done
          log={runState.log}
          message={activeUserMessage}
          modelId={runState.result.model}
        />
      );
    }

    return (
      <Box flexDirection="column">
        <Header
          modelId={runState.result.model}
          subtitle="Ready for follow-up"
        />
        <ChatHistory runs={completedRuns} />
        <ChatInput
          currentModelId={getDisplayModelId(displayModelId)}
          currentProvider={sessionProvider}
          onClear={clearSession}
          onCommandRun={submitCommandRun}
          onModelSelect={selectModel}
          onProviderSelect={selectProvider}
          onSubmit={submitChatMessage}
        />
      </Box>
    );
  }

  if (runState.status === "idle" && completedRuns.length > 0) {
    return (
      <Box flexDirection="column">
        <Header modelId={displayModelId} subtitle="Starting follow-up" />
        <ChatHistory runs={completedRuns} />
        {activeUserMessage ? <PromptBlock message={activeUserMessage} /> : null}
        <StatusLine tone="active" label="Next" value="starting openwiki" />
      </Box>
    );
  }

  if (runState.status === "error") {
    return (
      <Box flexDirection="column">
        <Header modelId={displayModelId} subtitle="Run failed" />
        <StatusLine tone="error" label="Error" value={runState.message} />
        {runState.authFix ? <AuthFixPanel authFix={runState.authFix} /> : null}
        {runState.credentialDiagnostics ? (
          <CredentialDiagnosticsPanel
            diagnostics={runState.credentialDiagnostics}
          />
        ) : null}
        {runState.errorDiagnostics && runState.errorDiagnostics.length > 0 ? (
          <ErrorDiagnosticsPanel diagnostics={runState.errorDiagnostics} />
        ) : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header modelId={displayModelId} subtitle="Ready for chat" />
      <ChatInput
        currentModelId={getDisplayModelId(displayModelId)}
        currentProvider={sessionProvider}
        onClear={clearSession}
        onCommandRun={submitCommandRun}
        onModelSelect={selectModel}
        onProviderSelect={selectProvider}
        onSubmit={submitChatMessage}
      />
    </Box>
  );
}

function HelpView() {
  return (
    <Box flexDirection="column">
      <Header modelId={null} subtitle={helpContent.description} />

      <Panel title="Usage">
        {helpContent.usage.map((line) => (
          <Text key={line}> {line}</Text>
        ))}
      </Panel>

      <Panel title="Commands">
        <Rows rows={helpContent.commands} />
      </Panel>

      <Panel title="Options">
        <Rows rows={helpContent.options} />
      </Panel>

      {isDevelopmentMode() ? (
        <Panel title="Development Options">
          <Rows rows={helpContent.developmentOptions} />
        </Panel>
      ) : null}

      <Panel title="Examples">
        {helpContent.examples.map((line) => (
          <Text key={line}> {line}</Text>
        ))}
        {isDevelopmentMode()
          ? helpContent.developmentExamples.map((line) => (
              <Text key={line}> {line}</Text>
            ))
          : null}
      </Panel>
    </Box>
  );
}

function DryRunView({
  command,
  modelId,
  shouldStart,
  userMessage,
}: {
  command: OpenWikiCommand;
  modelId: string | null;
  shouldStart: boolean;
  userMessage: string | null;
}) {
  return (
    <Box flexDirection="column">
      <Header modelId={modelId} subtitle="Development dry run" />
      <Panel title="Execution Plan">
        <StatusLine
          tone="active"
          label="Command"
          value={`openwiki ${command}`}
        />
        <StatusLine tone="muted" label="Mode" value={command} />
        <StatusLine
          tone="muted"
          label="Credentials"
          value="not read or requested"
        />
        <StatusLine
          tone="muted"
          label="Model"
          value={
            modelId ??
            `saved setting or ${getDefaultModelId(resolveConfiguredProvider())}`
          }
        />
        <StatusLine tone="muted" label="Agent" value="not invoked" />
        <StatusLine tone="muted" label="Writes" value="no files or metadata" />
        <StatusLine tone="muted" label="Output" value="~/.openwiki/wiki" />
        <StatusLine
          tone="muted"
          label="Startup"
          value={shouldStart ? "would start run" : "would open chat"}
        />
        {userMessage ? (
          <StatusLine tone="muted" label="Message" value={userMessage} />
        ) : null}
      </Panel>
    </Box>
  );
}

function CredentialDiagnosticsPanel({
  diagnostics,
}: {
  diagnostics: CredentialDiagnostic[];
}) {
  return (
    <Panel title="Credential Diagnostics">
      <Text color="gray">Raw secret values are intentionally not printed.</Text>
      {diagnostics.map((diagnostic) => (
        <Box flexDirection="column" key={diagnostic.key} marginTop={1}>
          <Text>
            <Text bold>{diagnostic.key}</Text>{" "}
            <Text color="gray">source={diagnostic.source}</Text>
          </Text>
          <Text>
            length={diagnostic.length ?? "unset"} preview={diagnostic.preview}
          </Text>
          <Text color={diagnostic.warnings.length > 0 ? "yellow" : "gray"}>
            warnings=
            {diagnostic.warnings.length > 0
              ? diagnostic.warnings.join(", ")
              : "none"}
          </Text>
        </Box>
      ))}
    </Panel>
  );
}

/**
 * The ordered "how to fix" steps for an auth failure. Shared by the interactive
 * panel and the --print stderr path so they stay in sync. Names env keys only,
 * never secret values.
 */
function AuthFixPanel({ authFix }: { authFix: AuthFix }) {
  const steps = getAuthFixSteps(authFix);

  return (
    <Panel title="How to fix">
      <Text>Your provider rejected the credentials for this run.</Text>
      {steps.map((step, index) => (
        <Text key={step}>
          <Text color="cyan">{index + 1}. </Text>
          {step}
        </Text>
      ))}
      <Text color="gray">For full detail, re-run with --debug.</Text>
    </Panel>
  );
}

function ErrorDiagnosticsPanel({
  diagnostics,
}: {
  diagnostics: ErrorDiagnostic[];
}) {
  return (
    <Panel title="Error Diagnostics">
      <Text color="gray">
        OPENWIKI_DEBUG=1 is enabled. Only allowlisted, non-secret error fields
        are shown.
      </Text>
      {diagnostics.map((diagnostic) => (
        <Text key={diagnostic.label}>
          <Text bold>{diagnostic.label}</Text> {diagnostic.value}
        </Text>
      ))}
    </Panel>
  );
}

function Header({
  compact = false,
  modelId,
  showLogo = true,
  subtitle,
}: {
  compact?: boolean;
  modelId?: string | null;
  showLogo?: boolean;
  subtitle: string;
}) {
  const terminalColumns = process.stdout.columns ?? 80;
  const displayModelId = sanitizeHeaderValue(
    modelId ??
      process.env[OPENWIKI_MODEL_ID_ENV_KEY] ??
      getDefaultModelId(resolveConfiguredProvider()),
    Math.max(8, terminalColumns - 12),
  );
  const configuredProvider = resolveConfiguredProvider();
  const displayProvider = getProviderLabel(configuredProvider);
  const chatGptAccount =
    configuredProvider === "openai-chatgpt"
      ? formatChatGptAccountFromEnv()
      : null;
  const displayDirectory = sanitizeHeaderValue(
    formatCwd(process.cwd()),
    Math.max(8, terminalColumns - 17),
  );
  const shouldShowLogo = showLogo && terminalColumns > OPENWIKI_LOGO_WIDTH;
  const tracingEnabled =
    process.env.LANGCHAIN_TRACING_V2 === "true" &&
    Boolean(process.env.LANGSMITH_API_KEY);

  if (compact) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text wrap="truncate">
          <Text color="cyan">{">_ "}</Text>
          <Text bold>OpenWiki</Text>{" "}
          <Text color="gray">v{OPENWIKI_VERSION}</Text>{" "}
          <Text color="gray">provider: </Text>
          <Text color="white">{displayProvider}</Text>{" "}
          {chatGptAccount ? (
            <>
              <Text color="gray">account: </Text>
              <Text color="white">{chatGptAccount}</Text>{" "}
            </>
          ) : null}
          <Text color="gray">model: </Text>
          <Text color="white">{displayModelId}</Text>
        </Text>
        <Text>
          <Text color={tracingEnabled ? "green" : "gray"}>
            {tracingEnabled ? "* " : "- "}
          </Text>
          <Text color={tracingEnabled ? "green" : "gray"}>
            LangSmith tracing {tracingEnabled ? "enabled" : "disabled"}
          </Text>
          <Text color="gray"> - </Text>
          <Text color="cyan">{subtitle}</Text>
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {shouldShowLogo ? (
        <Box flexDirection="column" marginBottom={1}>
          {OPENWIKI_LOGO_LINES.map((line) => (
            <Text bold color="cyan" key={line} wrap="truncate">
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box
        borderColor="cyan"
        borderStyle="round"
        flexDirection="column"
        marginBottom={1}
        paddingX={1}
      >
        <Text>
          <Text color="cyan">{">_ "}</Text>
          <Text bold>OpenWiki</Text>{" "}
          <Text color="gray">v{OPENWIKI_VERSION}</Text>{" "}
          <Text color="gray">agent docs for codebases</Text>
        </Text>
        <Text>
          <Text color="gray">provider: </Text>
          <Text color="white">{displayProvider}</Text>
        </Text>
        {chatGptAccount ? (
          <Text>
            <Text color="gray">account: </Text>
            <Text color="white">{chatGptAccount}</Text>
          </Text>
        ) : null}
        <Text>
          <Text color="gray">model: </Text>
          <Text color="white">{displayModelId}</Text>
        </Text>
        <Text>
          <Text color="gray">directory: </Text>
          <Text color="white">{displayDirectory}</Text>
        </Text>
      </Box>
      <Text>
        <Text color={tracingEnabled ? "green" : "gray"}>
          {tracingEnabled ? "* " : "- "}
        </Text>
        <Text color={tracingEnabled ? "green" : "gray"}>
          LangSmith tracing {tracingEnabled ? "enabled" : "disabled"}
        </Text>
        <Text color="gray"> - </Text>
        <Text color="cyan">{subtitle}</Text>
      </Text>
      <Text color="gray">
        Tip: ask for a docs change, or use /exit when you are done.
      </Text>
    </Box>
  );
}

type StatusLineProps = {
  tone: "active" | "error" | "muted" | "success";
  label: string;
  value: string;
};

function StatusLine({ tone, label, value }: StatusLineProps) {
  const color =
    tone === "success"
      ? "green"
      : tone === "error"
        ? "red"
        : tone === "active"
          ? "yellow"
          : "gray";

  return (
    <Text>
      <Text color={color}>* </Text>
      <Text bold color={color}>
        {label}
      </Text>{" "}
      <Text color={tone === "muted" ? "gray" : undefined}>{value}</Text>
    </Text>
  );
}

function IngestionSummary({ result }: { result: OpenWikiIngestionResult }) {
  return (
    <Panel title="Source Runs">
      {result.results.map((sourceResult) => (
        <StatusLine
          key={sourceResult.sourceInstanceId}
          label={sourceResult.displayName}
          tone={sourceResult.status === "error" ? "error" : "success"}
          value={`${sourceResult.status}; ${sourceResult.rawFiles.length} raw file(s)`}
        />
      ))}
    </Panel>
  );
}

type RunViewProps = {
  command: OpenWikiCommand;
  credentialDiagnostics?: CredentialDiagnostic[];
  log: RunLogItem[];
  done?: boolean;
  message?: string | null;
  modelId?: string | null;
};

function RunView({
  command,
  credentialDiagnostics,
  log,
  done = false,
  message = null,
  modelId = null,
}: RunViewProps) {
  const [animationFrame, setAnimationFrame] = useState(0);
  const activeRunningToolId = getActiveRunningToolLogId(log);
  const hasRunningTool = activeRunningToolId !== null;

  useEffect(() => {
    if (done || !hasRunningTool) {
      return;
    }

    const interval = setInterval(() => {
      setAnimationFrame((frame) => frame + 1);
    }, 140);

    return () => {
      clearInterval(interval);
    };
  }, [done, hasRunningTool]);

  return (
    <Box flexDirection="column">
      <Header
        compact
        modelId={modelId}
        showLogo={false}
        subtitle={done ? "Run complete" : "Agent running"}
      />
      {message ? <PromptBlock message={message} /> : null}
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color={done ? "green" : "cyan"}>* </Text>
          <Text bold>{done ? "Complete" : "Working"}</Text>{" "}
          <Text color="gray">openwiki {command}</Text>
          {!done ? <Text color="gray"> - streaming</Text> : null}
        </Text>
        <Box flexDirection="column" marginLeft={2} marginTop={1}>
          {log.length > 0 ? (
            log.map((item) => (
              <RunLogLine
                activeRunningToolId={activeRunningToolId}
                animationFrame={animationFrame}
                item={item}
                key={item.id}
              />
            ))
          ) : (
            <Text color="gray">Waiting for model output...</Text>
          )}
        </Box>
      </Box>
      {credentialDiagnostics ? (
        <CredentialDiagnosticsPanel diagnostics={credentialDiagnostics} />
      ) : null}
    </Box>
  );
}

function RunLogLine({
  activeRunningToolId = null,
  animationFrame = 0,
  item,
}: {
  activeRunningToolId?: number | null;
  animationFrame?: number;
  item: RunLogItem;
}) {
  if (item.type === "tool") {
    if (item.status === "running") {
      const isActive = item.id === activeRunningToolId;

      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            <Text color={isActive ? "cyan" : "gray"}>
              {isActive ? `${getSpinnerFrame(animationFrame)} ` : "* "}
            </Text>
            <Text bold={isActive} color={isActive ? "cyan" : "gray"}>
              {item.content}
            </Text>
          </Text>
          {isActive && item.call ? (
            <Text color="gray"> {truncateLogOutput(item.call, "")}</Text>
          ) : null}
        </Box>
      );
    }

    if (item.status === "error") {
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            <Text bold color="red">
              {"!! "}
            </Text>
            <Text bold color="red">
              {item.content}
            </Text>
          </Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="green">{"* "}</Text>
          <Text color="gray">{item.content}</Text>
        </Text>
      </Box>
    );
  }

  if (item.type === "debug") {
    return (
      <Text>
        <Text color="gray">- </Text>
        <Text color="gray">{item.content}</Text>
      </Text>
    );
  }

  return (
    <Box flexDirection="row">
      <Text color="white">* </Text>
      <Box flexDirection="column">
        <MarkdownText markdown={item.content.trim()} />
      </Box>
    </Box>
  );
}

function getActiveRunningToolLogId(log: RunLogItem[]): number | null {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const item = log[index];

    if (item.type === "tool" && item.status === "running") {
      return item.id;
    }
  }

  return null;
}

function MarkdownText({ markdown }: { markdown: string }) {
  const tokens = marked.lexer(markdown, {
    async: false,
    gfm: true,
  });

  return (
    <Box flexDirection="column">
      {tokens.map((token, index) => (
        <MarkdownBlock
          index={index}
          key={`${token.type}-${index}`}
          token={token}
        />
      ))}
    </Box>
  );
}

function MarkdownBlock({ index, token }: { index: number; token: Token }) {
  if (token.type === "space" || token.type === "def" || token.type === "hr") {
    return null;
  }

  if (token.type === "paragraph") {
    return (
      <Text wrap="wrap">
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "heading") {
    return (
      <Text wrap="wrap">
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "list") {
    return (
      <Box flexDirection="column">
        {(token as Tokens.List).items.map((item, itemIndex) => (
          <Text key={`${index}-${itemIndex}`} wrap="wrap">
            <Text color="gray">
              {(token as Tokens.List).ordered
                ? `${Number((token as Tokens.List).start || 1) + itemIndex}. `
                : "- "}
            </Text>
            <InlineMarkdown tokens={getTokenChildren(item)} />
          </Text>
        ))}
      </Box>
    );
  }

  if (token.type === "code") {
    return <Text color="gray">{token.text}</Text>;
  }

  if (token.type === "blockquote") {
    return (
      <Text wrap="wrap">
        <Text color="gray">| </Text>
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "table") {
    return <Text color="gray">{renderPlainTable(token as Tokens.Table)}</Text>;
  }

  if (token.type === "html") {
    return <Text wrap="wrap">{renderHtmlToken(token)}</Text>;
  }

  if (token.type === "text") {
    return (
      <Text wrap="wrap">
        <InlineMarkdown tokens={token.tokens ?? [token]} />
      </Text>
    );
  }

  return <Text wrap="wrap">{token.raw}</Text>;
}

function InlineMarkdown({ tokens }: { tokens: Token[] }) {
  return (
    <>
      {tokens.map((token, index) => (
        <InlineMarkdownToken key={`${token.type}-${index}`} token={token} />
      ))}
    </>
  );
}

function InlineMarkdownToken({ token }: { token: Token }) {
  if (token.type === "text" || token.type === "escape") {
    return <>{token.text}</>;
  }

  if (token.type === "strong") {
    return (
      <Text bold>
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "em") {
    return (
      <Text italic>
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "link") {
    return (
      <Text underline>
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "codespan") {
    return <Text color="gray">{token.text}</Text>;
  }

  if (token.type === "br") {
    return <>{"\n"}</>;
  }

  if (token.type === "del") {
    return (
      <Text strikethrough>
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "html") {
    return <>{renderHtmlToken(token)}</>;
  }

  if ("tokens" in token && Array.isArray(token.tokens)) {
    return <InlineMarkdown tokens={token.tokens} />;
  }

  return <>{token.raw}</>;
}

function getTokenChildren(token: Token): Token[] {
  return "tokens" in token && Array.isArray(token.tokens) ? token.tokens : [];
}

function renderPlainTable(token: Tokens.Table): string {
  const header = token.header.map((cell) => cell.text).join(" | ");
  const rows = token.rows.map((row) =>
    row.map((cell) => cell.text).join(" | "),
  );

  return [header, ...rows].filter(Boolean).join("\n");
}

function renderHtmlToken(token: Token): React.ReactNode {
  const text =
    "text" in token && typeof token.text === "string" ? token.text : token.raw;
  const underlineMatch = text.match(/^<u>(.*)<\/u>$/isu);

  if (underlineMatch) {
    return <Text underline>{underlineMatch[1]}</Text>;
  }

  return stripHtmlTags(text);
}

function ChatHistory({ runs }: { runs: CompletedRun[] }) {
  if (runs.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column">
      {runs.map((run) => (
        <Box flexDirection="column" key={run.id} marginBottom={1}>
          {run.message ? <PromptBlock message={run.message} /> : null}
          <Text>
            <Text color="green">* </Text>
            <Text bold>Complete</Text>{" "}
            <Text color="gray">
              openwiki {run.command} - {run.result.model}
            </Text>
          </Text>
          <Box flexDirection="column" marginLeft={2} marginTop={1}>
            {run.log.length > 0 ? (
              run.log.map((item) => <RunLogLine item={item} key={item.id} />)
            ) : (
              <Text color="gray">No assistant output captured.</Text>
            )}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

type ChatInputProps = {
  currentModelId: string;
  currentProvider: OpenWikiProvider;
  onClear: () => void;
  onCommandRun: (
    command: Extract<OpenWikiCommand, "init" | "update">,
    message: string | null,
  ) => void;
  onModelSelect: (modelId: string) => Promise<void>;
  onProviderSelect: (provider: OpenWikiProvider) => Promise<void>;
  onSubmit: (message: string) => void;
};

function ChatInput({
  currentModelId,
  currentProvider,
  onClear,
  onCommandRun,
  onModelSelect,
  onProviderSelect,
  onSubmit,
}: ChatInputProps) {
  const [inputState, setInputState] = useState<ChatInputState>({
    cursorPosition: 0,
    value: "",
  });
  const [menuState, setMenuState] = useState<ChatInputMenuState>({
    kind: "none",
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [secretInputMode, setSecretInputMode] =
    useState<SecretInputMode | null>(null);
  const input = inputState.value;
  const cursorPosition = inputState.cursorPosition;

  useEffect(() => {
    if (secretInputMode !== null) {
      return;
    }

    setMenuState((currentState) =>
      syncMenuStateForInput(
        input,
        currentState,
        currentModelId,
        currentProvider,
      ),
    );
  }, [currentModelId, currentProvider, input, secretInputMode]);

  useInput((inputValue, key) => {
    if (isSaving) {
      return;
    }

    if (secretInputMode !== null) {
      if (isEscapeInput(inputValue, key)) {
        resetInput();
        setSecretInputMode(null);
        setNotice("Credential update canceled.");
        return;
      }

      if (key.return) {
        void saveSecretInput();
        return;
      }

      if (key.backspace || isRawBackspaceInput(inputValue)) {
        setInputState(deleteBeforeInputCursor);
        return;
      }

      if (key.delete) {
        setInputState(
          inputValue.length === 0
            ? deleteBeforeInputCursor
            : deleteAtInputCursor,
        );
        return;
      }

      if (inputValue && !key.ctrl && !key.meta) {
        setError(null);
        setNotice(null);
        setInputState((state) => applyRawInputValue(state, inputValue));
      }

      return;
    }

    if (isMenuUpInput(inputValue, key) && menuState.kind !== "none") {
      setMenuState((state) =>
        moveMenuSelection(state, -1, currentModelId, currentProvider),
      );
      return;
    }

    if (isMenuDownInput(inputValue, key) && menuState.kind !== "none") {
      setMenuState((state) =>
        moveMenuSelection(state, 1, currentModelId, currentProvider),
      );
      return;
    }

    if (key.return) {
      void submitInput();
      return;
    }

    if (isEscapeInput(inputValue, key) && menuState.kind !== "none") {
      resetInput();
      return;
    }

    if (key.leftArrow) {
      setInputState((state) => moveInputCursor(state, -1));
      return;
    }

    if (key.rightArrow) {
      setInputState((state) => moveInputCursor(state, 1));
      return;
    }

    if ((key.ctrl && inputValue === "a") || inputValue === "\u0001") {
      setInputState((state) => ({
        ...state,
        cursorPosition: 0,
      }));
      return;
    }

    if ((key.ctrl && inputValue === "e") || inputValue === "\u0005") {
      setInputState((state) => ({
        ...state,
        cursorPosition: state.value.length,
      }));
      return;
    }

    if (key.backspace || isRawBackspaceInput(inputValue)) {
      setInputState(deleteBeforeInputCursor);
      return;
    }

    if (key.delete) {
      setInputState(
        inputValue.length === 0 ? deleteBeforeInputCursor : deleteAtInputCursor,
      );
      return;
    }

    if (inputValue && !key.ctrl && !key.meta) {
      setError(null);
      setNotice(null);
      setInputState((state) => applyRawInputValue(state, inputValue));
    }
  });

  async function submitInput() {
    const message = input.trim();

    if (message.length === 0) {
      setError("Enter a follow-up message.");
      return;
    }

    if (message.startsWith("/")) {
      await submitSlashInput(message);
      return;
    }

    resetInput();
    onSubmit(message);
  }

  async function submitSlashInput(message: string) {
    if (message === "/" && menuState.kind === "commands") {
      await runSlashCommand(slashCommandOptions[menuState.selectedIndex]);
      return;
    }

    if (message === "/model" && menuState.kind === "model") {
      await selectModelMenuOption(menuState.selectedIndex);
      return;
    }

    if (message === "/provider" && menuState.kind === "provider") {
      await selectProviderMenuOption(menuState.selectedIndex);
      return;
    }

    const parsedCommand = parseSlashInput(message);

    if (parsedCommand === null) {
      setError(`Unknown command: ${message}`);
      return;
    }

    await runSlashCommand(
      parsedCommand.option,
      parsedCommand.args.length > 0 ? parsedCommand.args : null,
    );
  }

  async function runSlashCommand(
    option: SlashCommandOption | undefined,
    args: string | null = null,
  ) {
    if (!option) {
      setError("Select a slash command.");
      return;
    }

    if (option.id === "model") {
      if (args && args.length > 0) {
        await saveModelSelection(args);
        return;
      }

      setError(null);
      setNotice("Choose a model, or type /model <model-id>.");
      setInputValue("/model");
      setMenuState({
        kind: "model",
        selectedIndex: getCurrentModelOptionIndex(
          currentModelId,
          currentProvider,
        ),
      });
      return;
    }

    if (option.id === "provider") {
      if (args && args.length > 0) {
        await saveProviderSelection(args);
        return;
      }

      setError(null);
      setNotice("Choose a provider, or type /provider <provider-id>.");
      setInputValue("/provider");
      setMenuState({
        kind: "provider",
        selectedIndex: getCurrentProviderOptionIndex(currentProvider),
      });
      return;
    }

    if (option.id === "api-key") {
      if (args && args.length > 0) {
        setError(
          "Use the masked prompt for API keys; do not pass keys inline.",
        );
        return;
      }

      if (providerUsesAwsSdkCredentials(currentProvider)) {
        setError(
          `${getProviderLabel(currentProvider)} uses the AWS SDK credential chain; /api-key cannot safely configure an access-key pair. ${getProviderCredentialHint(currentProvider) ?? ""} Legacy BEDROCK_AWS_ACCESS_KEY_ID and BEDROCK_AWS_SECRET_ACCESS_KEY values must be configured or removed together in the shell and ~/.openwiki/.env.`.trim(),
        );
        return;
      }

      const apiKeyEnvKey = getProviderApiKeyEnvKey(currentProvider);

      if (!apiKeyEnvKey) {
        const hint = getProviderCredentialHint(currentProvider);

        setError(
          `${getProviderLabel(currentProvider)} does not use an API key.${
            hint ? ` ${hint}` : ""
          }`,
        );
        return;
      }

      setError(null);
      setNotice(`Paste your ${getProviderLabel(currentProvider)} API key.`);
      setSecretInputMode({
        envKey: apiKeyEnvKey,
        kind: "api-key",
        label: `${getProviderLabel(currentProvider)} API key`,
        provider: currentProvider,
      });
      setInputState({ cursorPosition: 0, value: "" });
      setMenuState({ kind: "none" });
      return;
    }

    if (option.id === "langsmith-key") {
      if (args && args.length > 0) {
        setError(
          "Use the masked prompt for LangSmith keys; do not pass keys inline.",
        );
        return;
      }

      setError(null);
      setNotice("Paste your LangSmith API key, or press Enter empty to clear.");
      setSecretInputMode({
        envKey: "LANGSMITH_API_KEY",
        kind: "langsmith-key",
        label: "LangSmith API key",
      });
      setInputState({ cursorPosition: 0, value: "" });
      setMenuState({ kind: "none" });
      return;
    }

    if (option.id === "init" || option.id === "update") {
      resetInput();
      onCommandRun(option.id, args);
      return;
    }

    if (option.id === "clear") {
      resetInput();
      onClear();
      setNotice("Started a new chat thread.");
      return;
    }

    if (option.id === "help") {
      resetInput();
      setNotice(
        "Slash commands: /provider, /model, /api-key, /langsmith-key, /init, /update, /clear, /help, /exit. Use arrows to select.",
      );
      return;
    }

    resetInput();
    onSubmit("/exit");
  }

  async function selectModelMenuOption(selectedIndex: number) {
    const option = getModelMenuOptions(currentModelId, currentProvider)[
      selectedIndex
    ];

    if (!option) {
      setError("Select a model.");
      return;
    }

    if (option.kind === "custom") {
      setError(null);
      setNotice("Type a custom model ID after /model.");
      setInputValue("/model ");
      return;
    }

    await saveModelSelection(option.modelId);
  }

  async function saveModelSelection(rawModelId: string) {
    const modelId = normalizeModelId(rawModelId);

    if (!isValidModelId(modelId)) {
      setError("Enter a valid model ID.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      await onModelSelect(modelId);
      resetInput();
      setNotice(`Model switched to ${modelId}.`);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save model selection.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function selectProviderMenuOption(selectedIndex: number) {
    const provider = SELECTABLE_OPENWIKI_PROVIDERS[selectedIndex];

    if (!provider) {
      setError("Select a provider.");
      return;
    }

    await saveProviderSelection(provider);
  }

  async function saveProviderSelection(rawProvider: string) {
    const provider = normalizeProvider(rawProvider);

    if (provider === null) {
      setError(
        `Enter a valid provider: ${SELECTABLE_OPENWIKI_PROVIDERS.join(", ")}.`,
      );
      return;
    }

    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      await onProviderSelect(provider);
      resetInput();
      const apiKeyEnvKey = getProviderApiKeyEnvKey(provider);
      const requirement = providerUsesAwsSdkCredentials(provider)
        ? (getProviderCredentialHint(provider) ??
          "Configure AWS SDK credentials.")
        : apiKeyEnvKey
          ? `Ensure ${apiKeyEnvKey} is set.`
          : `Ensure ${getProviderProjectEnvKey(provider)} is set. ${getProviderCredentialHint(provider) ?? ""}`.trim();
      const modelNotice =
        getProviderModelOptions(provider).length > 0
          ? ` with model ${getDefaultModelId(provider)}`
          : ". Set a model with /model";

      setNotice(
        `Provider switched to ${getProviderLabel(provider)}${modelNotice}. ${requirement}`,
      );
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save provider selection.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function saveSecretInput() {
    if (secretInputMode === null) {
      return;
    }

    const nextValue = input.trim();
    if (secretInputMode.kind === "api-key" && nextValue.length === 0) {
      setError(`${secretInputMode.envKey} is required.`);
      return;
    }

    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      if (secretInputMode.kind === "langsmith-key") {
        await saveOpenWikiEnv({
          LANGCHAIN_PROJECT: nextValue.length > 0 ? "openwiki" : "",
          LANGCHAIN_TRACING_V2: nextValue.length > 0 ? "true" : "false",
          LANGSMITH_API_KEY: nextValue,
        });
      } else {
        await saveOpenWikiEnv({
          [secretInputMode.envKey]: nextValue,
        });
      }

      const savedLabel = secretInputMode.label;
      resetInput();
      setSecretInputMode(null);
      setNotice(`${savedLabel} saved.`);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save credential.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  function resetInput() {
    setInputState({ cursorPosition: 0, value: "" });
    setMenuState({ kind: "none" });
    setError(null);
  }

  function setInputValue(value: string) {
    setInputState({
      cursorPosition: value.length,
      value,
    });
  }

  const beforeCursor = input.slice(0, cursorPosition);
  const afterCursor = input.slice(cursorPosition);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box borderStyle="single" borderColor="blue" paddingX={1}>
        <Text>
          <Text color="blue">{">"}</Text>{" "}
          {secretInputMode !== null ? (
            <>
              <Text color="gray">{secretInputMode.envKey}=</Text>
              <Text color="yellow">{formatSecretInputSummary(input)}</Text>
            </>
          ) : input.length > 0 ? (
            <>
              {beforeCursor}
              <InputCursor />
              {afterCursor}
            </>
          ) : (
            <>
              <InputCursor />
              <Text color="gray"> Ask a follow-up...</Text>
            </>
          )}
        </Text>
      </Box>
      <Text>
        <Text color="gray">
          {secretInputMode !== null
            ? "enter to save - esc to cancel - input is masked"
            : `enter to send - / for commands - /exit to quit - cwd ${formatCwd(
                process.cwd(),
              )}`}
        </Text>
      </Text>
      {secretInputMode !== null ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">{secretInputMode.label}</Text>
          <Text>
            Saving to <Text color="cyan">{secretInputMode.envKey}</Text>
          </Text>
          {secretInputMode.kind === "langsmith-key" ? (
            <Text color="gray">Press Enter empty to clear LangSmith.</Text>
          ) : null}
        </Box>
      ) : menuState.kind !== "none" ? (
        <SlashMenu
          currentModelId={currentModelId}
          currentProvider={currentProvider}
          input={input}
          menuState={menuState}
        />
      ) : null}
      {notice ? <Text color="green">{notice}</Text> : null}
      {isSaving ? <Text color="gray">Saving selection...</Text> : null}
      {error ? <Text color="red">{error}</Text> : null}
    </Box>
  );
}

function SlashMenu({
  currentModelId,
  currentProvider,
  input,
  menuState,
}: {
  currentModelId: string;
  currentProvider: OpenWikiProvider;
  input: string;
  menuState: Exclude<ChatInputMenuState, { kind: "none" }>;
}) {
  if (menuState.kind === "model") {
    const modelOptions = getModelMenuOptions(currentModelId, currentProvider);

    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="gray">Models for {getProviderLabel(currentProvider)}</Text>
        {modelOptions.map((option, index) => (
          <MenuRow
            description={
              option.kind === "model" && option.modelId === currentModelId
                ? "current"
                : option.kind === "custom"
                  ? "type /model <model-id>"
                  : ""
            }
            isSelected={index === menuState.selectedIndex}
            key={option.label}
            label={option.label}
          />
        ))}
        {input.startsWith("/model ") ? (
          <Text color="gray">Press enter to save the custom model ID.</Text>
        ) : (
          <Text color="gray">Use arrows, enter to select, esc to cancel.</Text>
        )}
      </Box>
    );
  }

  if (menuState.kind === "provider") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="gray">Providers</Text>
        {SELECTABLE_OPENWIKI_PROVIDERS.map((provider, index) => (
          <MenuRow
            description={
              provider === currentProvider
                ? "current"
                : `default model ${getDefaultModelId(provider)}`
            }
            isSelected={index === menuState.selectedIndex}
            key={provider}
            label={getProviderLabel(provider)}
          />
        ))}
        <Text color="gray">Use arrows, enter to select, esc to cancel.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="gray">Commands</Text>
      {slashCommandOptions.map((option, index) => (
        <MenuRow
          description={option.description}
          isSelected={index === menuState.selectedIndex}
          key={option.id}
          label={option.label}
        />
      ))}
      <Text color="gray">Use arrows, enter to select, esc to cancel.</Text>
    </Box>
  );
}

function MenuRow({
  description,
  isSelected,
  label,
}: {
  description: string;
  isSelected: boolean;
  label: string;
}) {
  return (
    <Text>
      <Text color={isSelected ? "cyan" : "gray"}>{isSelected ? ">" : " "}</Text>{" "}
      <Text bold={isSelected}>{label.padEnd(28)}</Text>
      <Text color="gray">{description}</Text>
    </Text>
  );
}

function InputCursor() {
  return <Text color="cyan">|</Text>;
}

function PromptBlock({ message }: { message: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text backgroundColor="gray" wrap="wrap">
        {" "}
        <Text color="cyan">{">"}</Text> {message}
      </Text>
    </Box>
  );
}

function updateRunningCredentialDiagnostics(
  state: RunState,
  credentialDiagnostics: CredentialDiagnostic[],
  credentialDiagnosticsRef: React.MutableRefObject<
    CredentialDiagnostic[] | undefined
  >,
): RunState {
  credentialDiagnosticsRef.current = credentialDiagnostics;

  return state.status === "running"
    ? {
        ...state,
        credentialDiagnostics,
      }
    : state;
}

type PanelProps = {
  title: string;
  children: React.ReactNode;
};

function Panel({ title, children }: PanelProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="cyan"># </Text>
        <Text bold>{title}</Text>
      </Text>
      <Box flexDirection="column" marginLeft={2}>
        {children}
      </Box>
    </Box>
  );
}

type RowsProps = {
  rows: HelpRow[];
};

function Rows({ rows }: RowsProps) {
  const labelWidth = Math.max(...rows.map((row) => row.label.length));

  return (
    <>
      {rows.map((row) => (
        <Text key={row.label}>
          {"  "}
          {row.label.padEnd(labelWidth)}
          {"  "}
          {row.description}
        </Text>
      ))}
    </>
  );
}

const argv = process.argv.slice(2);
const parsedCommand = parseCommand(argv);

if (
  (parsedCommand.kind === "run" && !parsedCommand.dryRun) ||
  parsedCommand.kind === "auth" ||
  parsedCommand.kind === "cron" ||
  parsedCommand.kind === "ingest" ||
  parsedCommand.kind === "ngrok"
) {
  await loadOpenWikiEnv();
}

const command = await resolveStartupCommand(parsedCommand, {
  cwd: process.cwd(),
  isStdinTTY: Boolean(process.stdin.isTTY),
});

// Decide once, before any event is sent, whether this is the first run on this
// machine (mints the install id). False when suppressed (opt-out or CI) or after
// the first run. How it is shown depends on the render path below.
let showFirstRunNotice = false;
if (commandEmitsTelemetry(command)) {
  showFirstRunNotice = await firstRunNoticePending();
}

if (command.kind === "run" && command.languageWarning) {
  // stderr keeps piped stdout clean while still warning about an ignored locale.
  process.stderr.write(`${command.languageWarning}\n`);
}

if (command.kind === "auth") {
  await runAuthCommand(command);
} else if (command.kind === "ngrok") {
  await runNgrokCommand(command);
} else if (command.kind === "cron") {
  await runCronCommand(command);
} else if (command.kind === "ingest") {
  await runIngestCommand(command);
} else if (command.kind === "visualize") {
  await runVisualizeCommand(command);
} else if (shouldPrintStartupError(argv, parsedCommand, command)) {
  process.stderr.write(`${command.message}\n`);
  process.exitCode = command.exitCode;
} else if (shouldRunNonInteractively(command, process.stdin.isTTY === true)) {
  // Non-TTY / print mode: framed text on stderr so piped stdout stays clean;
  // gray only when stderr is a real terminal.
  if (showFirstRunNotice) {
    console.error(renderFirstRunNoticeText(process.stderr.isTTY === true));
  }
  await runPrintCommand(command);
} else {
  // Interactive TUI: render the notice as a box above the app so it matches
  // the rest of the interface.
  render(
    <>
      {showFirstRunNotice ? <FirstRunNotice /> : null}
      <App command={command} />
    </>,
  );
}

async function runNgrokCommand(
  command: Extract<CliCommand, { kind: "ngrok" }>,
): Promise<void> {
  try {
    await startNgrokTunnel({
      port: command.port,
      url: command.url,
    });
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

/**
 * Start the wiki visualizer server for a resolved wiki directory. Blocks until the
 * server is stopped with Ctrl-C; surfaces a missing-directory error cleanly.
 */
async function runVisualizeCommand(
  command: Extract<CliCommand, { kind: "visualize" }>,
): Promise<void> {
  const wikiRoot = path.resolve(process.cwd(), command.wikiDir);
  try {
    await runVisualizeServer({
      wikiRoot,
      port: command.port,
      open: command.open,
    });
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

async function runCronCommand(
  command: Extract<CliCommand, { kind: "cron" }>,
): Promise<void> {
  try {
    const config = await readOpenWikiOnboardingConfig();

    if (command.action !== "list") {
      if (!command.target) {
        throw new Error(`Target is required for cron ${command.action}.`);
      }

      const result =
        command.action === "pause"
          ? await pauseConnectorSchedules(config, command.target)
          : command.action === "resume"
            ? await resumeConnectorSchedules({
                config,
                cwd: process.cwd(),
                target: command.target,
              })
            : await deleteConnectorSchedules(config, command.target);

      await saveOpenWikiOnboardingConfig(result.config);
      process.stdout.write(
        formatScheduleMutationResult(command.action, result),
      );
      await printCronSchedules(result.config);
      process.exitCode = 0;
      return;
    }

    await printCronSchedules(config);
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

async function printCronSchedules(
  config: Awaited<ReturnType<typeof readOpenWikiOnboardingConfig>>,
): Promise<void> {
  const schedules = await listConnectorSchedules(config);
  const powerSchedule = getSavedPowerScheduleStatus(config);

  process.stdout.write(formatScheduleHeader(schedules.length));
  process.stdout.write(formatPowerScheduleStatus(powerSchedule));

  if (schedules.length === 0) {
    process.stdout.write("No connector schedules are configured.\n");
    return;
  }

  for (const schedule of schedules) {
    process.stdout.write(formatScheduleStatus(schedule));
  }
}

async function runIngestCommand(
  command: Extract<CliCommand, { kind: "ingest" }>,
): Promise<void> {
  try {
    const result = await runOpenWikiIngestion(process.cwd(), {
      debug: isDebugMode(),
      modelId: command.modelId,
      scheduledOnly: command.scheduledOnly,
      target: command.target,
      onEvent: (event) => {
        if (event.type === "text" && event.source !== "subgraph") {
          process.stdout.write(event.text);
        }
      },
    });

    process.stdout.write("\nIngestion summary\n");
    for (const sourceResult of result.results) {
      process.stdout.write(
        `- ${sourceResult.displayName}: ${sourceResult.status}; ${sourceResult.rawFiles.length} raw file(s)\n`,
      );
    }

    const hadError = result.results.some(
      (sourceResult) => sourceResult.status === "error",
    );

    process.exitCode = hadError ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    writePrintErrorDiagnostics(error);
    process.exitCode = 1;
  }
}

async function runAuthCommand(
  command: Extract<CliCommand, { kind: "auth" }>,
): Promise<void> {
  try {
    if (command.action === "list") {
      process.stdout.write(`${formatAuthProviderList()}\n`);
    } else {
      if (command.provider === null) {
        throw new Error("Auth provider is required.");
      }

      if (command.action === "configure") {
        const result = await configureAuthProvider(command.provider, {
          force: command.force,
        });
        process.stdout.write(
          `${result.status === "exists" ? "Config already exists" : `Config ${result.status}`}: ${result.configPath}\n`,
        );
        for (const nextStep of result.nextSteps) {
          process.stdout.write(`- ${nextStep}\n`);
        }
      } else if (command.action === "tools") {
        const result = await listAuthProviderTools(command.provider);
        process.stdout.write(
          `Tools for ${result.provider} (${result.configPath})\n`,
        );
        process.stdout.write(`Wrote discovery: ${result.rawFile}\n`);
        process.stdout.write(`${JSON.stringify(result.tools, null, 2)}\n`);
      } else {
        const result = await runOAuthAuth(command.provider);
        process.stdout.write(
          `Saved ${result.provider} auth values: ${result.savedEnvKeys.join(", ")}\n`,
        );
        const configureResult = await configureAuthProvider(command.provider, {
          force: command.force,
        });
        process.stdout.write(
          `${configureResult.status === "exists" ? "Config already exists" : `Config ${configureResult.status}`}: ${configureResult.configPath}\n`,
        );
        for (const nextStep of configureResult.nextSteps) {
          process.stdout.write(`- ${nextStep}\n`);
        }

        if (shouldDiscoverToolsAfterAuth(command.provider)) {
          try {
            const toolsResult = await listAuthProviderTools(command.provider);
            process.stdout.write(
              `Discovered ${toolsResult.tools.length} MCP tool(s); wrote ${toolsResult.rawFile}\n`,
            );
            const toolNames = toolsResult.tools
              .map((tool) => tool.name)
              .slice(0, 20);
            if (toolNames.length > 0) {
              process.stdout.write(`Tools: ${toolNames.join(", ")}\n`);
            }
          } catch (error) {
            process.stdout.write(
              `MCP tool discovery skipped: ${getErrorMessage(error)}\n`,
            );
          }
        }
      }
    }

    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

/**
 * Builds the telemetry context for a run from the parsed command. Flag names
 * only, never argument values.
 */
async function runPrintCommand(
  command: Extract<CliCommand, { kind: "run" }>,
): Promise<void> {
  try {
    const output: string[] = [];

    const runtimeCwd = getRunModeCwd(command.mode);
    const runtimeOutputMode = getRunModeOutputMode(command.mode);

    const handlePrintEvent = (event: OpenWikiRunEvent): void => {
      if (event.type === "text" && event.source !== "subgraph") {
        output.push(event.text);
      }
    };

    const runOptions: OpenWikiRunOptions = {
      debug: isDebugMode(),
      isFollowup: command.command === "chat",
      language: command.language,
      modelId: command.modelId,
      outputMode: runtimeOutputMode,
      threadId: createOpenWikiThreadId(runtimeCwd),
      telemetryFile: command.telemetryFile ?? undefined,
      onEvent: handlePrintEvent,
    };

    // withRunTelemetry is the single boundary that records this run, wrapping repo
    // setup and the connector pull as well as the agent so a throw in either
    // pre-agent step is recorded rather than only surfaced on stderr below.
    const telemetryContext: RunTelemetryContext = {};

    await withRunTelemetry(
      command.command,
      runOptions,
      telemetryContext,
      async () => {
        if (command.mode === "code") {
          await ensureCodeModeRepoSetup(runtimeCwd, {
            createWorkflow: command.command === "init",
          });
        }

        // Code-mode connectors (e.g. langsmith) pull their evidence and augment
        // the agent message before the run, so --print behaves exactly like
        // interactive.
        const userMessage =
          command.mode === "code" && command.command !== "chat"
            ? await runCodeModeConnectors(
                runtimeCwd,
                command.userMessage ?? undefined,
                handlePrintEvent,
              )
            : command.userMessage;

        await runOpenWikiAgent(
          command.command,
          runtimeCwd,
          { ...runOptions, userMessage },
          telemetryContext,
        );
      },
    );

    const text = output.join("").trim();

    if (text.length > 0) {
      process.stdout.write(`${text}\n`);
    }

    process.exitCode = 0;
  } catch (error) {
    const message = getErrorMessage(error);
    process.stderr.write(`${message}\n`);
    writePrintAuthFix(error, message);
    writePrintErrorDiagnostics(error);
    process.exitCode = 1;
  }
}

/**
 * Write the concise auth "how to fix" guidance to stderr on a non-interactive
 * failure, mirroring the interactive panel so CI/print runs get the same help.
 * No-op unless the failure looks like an auth error. Key names only.
 */
function writePrintAuthFix(error: unknown, message: string): void {
  const authFix = getAuthFix(error, message, resolveConfiguredProvider());

  if (!authFix) {
    return;
  }

  process.stderr.write("\nHow to fix\n");
  process.stderr.write(
    "Your provider rejected the credentials for this run.\n",
  );

  getAuthFixSteps(authFix).forEach((step, index) => {
    process.stderr.write(`${index + 1}. ${step}\n`);
  });

  process.stderr.write("For full detail, re-run with --debug.\n");
}

function writePrintErrorDiagnostics(error: unknown): void {
  const diagnostics = getErrorDiagnostics(error);

  if (diagnostics.length === 0) {
    return;
  }

  process.stderr.write("\nError Diagnostics\n");

  for (const diagnostic of diagnostics) {
    process.stderr.write(`${diagnostic.label}: ${diagnostic.value}\n`);
  }
}
