#!/usr/bin/env node
import path from "node:path";
import { scheduler } from "node:timers/promises";
import React, { useEffect, useRef, useState } from "react";
import { Box, render, useApp } from "ink";
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
  parseCommand,
  shouldRunNonInteractively,
  type CliCommand,
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
import type { RunLogItem } from "./run-log/types.js";
import { appendRunLogEvent } from "./run-log/reducer.js";
import type { CompletedRun } from "./components/types.js";
import { Header } from "./components/header.js";
import { PromptBlock, StatusLine } from "./components/primitives.js";
import {
  FirstRunNotice,
  renderFirstRunNoticeText,
} from "./components/first-run-notice.js";
import {
  AuthFixPanel,
  CredentialDiagnosticsPanel,
  DryRunView,
  ErrorDiagnosticsPanel,
  HelpView,
} from "./components/panels.js";
import { IngestionSummary, RunView } from "./components/run-view.js";
import { ChatHistory, ChatInput } from "./components/chat.js";
import { getDisplayModelId, isExitMessage } from "./format.js";
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
import { getErrorMessage } from "../platform/diagnostics.js";
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
  getProviderCredentialHint,
  getProviderLabel,
  getProviderModelOptions,
  OPENWIKI_PROVIDER_ENV_KEY,
  OPENWIKI_MODEL_ID_ENV_KEY,
  resolveConfiguredProvider,
  type OpenWikiProvider,
} from "../config/constants.js";
import type { OpenWikiCommand, OpenWikiRunOptions } from "../agent/types.js";
import {
  firstRunNoticePending,
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

type AppProps = {
  command: CliCommand;
};

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
