import React, { useEffect, useRef, useState } from "react";
import { Box, useApp, useInput } from "ink";
import { scheduler } from "node:timers/promises";
import { createOpenWikiThreadId, runOpenWikiAgent } from "../../agent/index.js";
import type {
  OpenWikiCommand,
  OpenWikiRunEvent,
  OpenWikiRunOptions,
} from "../../agent/types.js";
import {
  getDefaultModelId,
  getMissingProviderEnvKey,
  getProviderCredentialHint,
  getProviderLabel,
  getProviderModelOptions,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
  OPENWIKI_REASONING_EFFORT_ENV_KEY,
  resolveConfiguredProvider,
  type OpenWikiProvider,
} from "../../config/constants.js";
import {
  getReasoningCapability,
  isReasoningEffort,
  type ReasoningEffort,
} from "../../config/reasoning.js";
import {
  getCredentialDiagnostics,
  getShellEnvValue,
  saveOpenWikiEnv,
  type CredentialDiagnostic,
} from "../../config/env.js";
import {
  ensureCodeModeRepoSetup,
  runCodeModeConnectors,
} from "../../ingestion/code-mode.js";
import { runOpenWikiIngestion } from "../../ingestion/ingestion.js";
import { getErrorMessage } from "../../platform/diagnostics.js";
import { InitSetup, needsCredentialSetup } from "../../setup/credentials.js";
import {
  withRunTelemetry,
  type RunTelemetryContext,
} from "../../telemetry/index.js";
import type { CliCommand, OpenWikiRunMode } from "../commands.js";
import { AuthFixPanel } from "../components/panels.js";
import { CredentialDiagnosticsPanel } from "../components/panels.js";
import { DryRunView } from "../components/panels.js";
import { ErrorDiagnosticsPanel } from "../components/panels.js";
import { HelpView } from "../components/panels.js";
import { Header } from "../components/header.js";
import {
  ChatHistory,
  ChatInput,
  type ReasoningEffortSelectionResult,
} from "../components/chat.js";
import { IngestionSummary, RunView } from "../components/run-view.js";
import { PromptBlock, StatusLine } from "../components/primitives.js";
import type { CompletedRun } from "../components/types.js";
import { isDebugMode, shouldShowCredentialDiagnostics } from "../debug.js";
import { getAuthFix } from "../diagnostics/auth-fix.js";
import { getErrorDiagnostics } from "../diagnostics/error-diagnostics.js";
import { getDisplayModelId, isExitMessage } from "../format.js";
import { requestProcessInterrupt } from "../process-interrupt.js";
import { appendRunLogEvent } from "../run-log/reducer.js";
import type { RunLogItem } from "../run-log/types.js";
import {
  getRunModeCwd,
  getRunModeOutputMode,
  shouldAutoExitStartupRun,
} from "../run-mode.js";
import { updateRunningCredentialDiagnostics } from "./run-state.js";
import type { RunState } from "./run-state.js";

/**
 * Props for the interactive OpenWiki application shell.
 */
interface AppProps {
  /**
   * Parsed CLI command that configures the application session.
   */
  command: CliCommand;
}

// Coalesce bursts of tool lifecycle events so Ink redraws at most four times
// per second while preserving the final in-memory log immediately.
const RUN_LOG_RENDER_DELAY_MS = 250;

function getConfiguredReasoningEffort(): ReasoningEffort | null {
  const effort = process.env[OPENWIKI_REASONING_EFFORT_ENV_KEY]?.trim();

  return effort && isReasoningEffort(effort) ? effort : null;
}

function shouldClearReasoningEffort(
  provider: OpenWikiProvider,
  modelId: string | null,
  effort: string | null,
): boolean {
  if (effort === null) {
    return false;
  }

  if (!modelId || !isReasoningEffort(effort)) {
    return true;
  }

  return !getReasoningCapability(provider, modelId)?.values.includes(effort);
}

export function App({ command }: AppProps) {
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
  const [sessionReasoningEffort, setSessionReasoningEffort] =
    useState<ReasoningEffort | null>(getConfiguredReasoningEffort);
  const activeRunId = useRef(0);
  const interruptRequested = useRef(false);
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
  const activeRunRenderTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
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

  function cancelPendingRunLogRender(): void {
    if (activeRunRenderTimer.current === null) {
      return;
    }

    clearTimeout(activeRunRenderTimer.current);
    activeRunRenderTimer.current = null;
  }

  useInput((input, key) => {
    if (!key.ctrl || input !== "c" || interruptRequested.current) {
      return;
    }

    interruptRequested.current = true;
    process.exitCode = 130;
    cancelPendingRunLogRender();
    requestProcessInterrupt(app.exit);
  });

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
    cancelPendingRunLogRender();
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
    const clearReasoningEffort = shouldClearReasoningEffort(
      sessionProvider,
      modelId,
      sessionReasoningEffort,
    );
    await saveOpenWikiEnv({
      [OPENWIKI_MODEL_ID_ENV_KEY]: modelId,
      ...(clearReasoningEffort
        ? { [OPENWIKI_REASONING_EFFORT_ENV_KEY]: "" }
        : {}),
    });
    setSessionModelId(modelId);
    if (clearReasoningEffort) {
      setSessionReasoningEffort(null);
    }
  }

  async function selectProvider(provider: OpenWikiProvider) {
    const modelId =
      getProviderModelOptions(provider).length > 0
        ? getDefaultModelId(provider)
        : null;
    const clearReasoningEffort = shouldClearReasoningEffort(
      provider,
      modelId,
      sessionReasoningEffort,
    );

    await saveOpenWikiEnv({
      [OPENWIKI_PROVIDER_ENV_KEY]: provider,
      ...(modelId ? { [OPENWIKI_MODEL_ID_ENV_KEY]: modelId } : {}),
      ...(clearReasoningEffort
        ? { [OPENWIKI_REASONING_EFFORT_ENV_KEY]: "" }
        : {}),
    });
    setSessionProvider(provider);
    setSessionModelId(modelId);
    if (clearReasoningEffort) {
      setSessionReasoningEffort(null);
    }
  }

  async function selectReasoningEffort(
    effort: ReasoningEffort | null,
  ): Promise<ReasoningEffortSelectionResult> {
    const modelId = getDisplayModelId(displayModelId);
    const capability = getReasoningCapability(sessionProvider, modelId);

    if (!capability) {
      throw new Error(
        `Reasoning effort is not supported for ${getProviderLabel(sessionProvider)} model ${modelId}.`,
      );
    }

    if (effort !== null && !capability.values.includes(effort)) {
      throw new Error(
        `Unsupported reasoning effort "${effort}". Available values: ${capability.values.join(", ")}.`,
      );
    }

    await saveOpenWikiEnv({
      [OPENWIKI_REASONING_EFFORT_ENV_KEY]: effort ?? "",
    });
    const isShadowedByShell =
      getShellEnvValue(OPENWIKI_REASONING_EFFORT_ENV_KEY) !== undefined;

    // Keep the header, menu, completed-run metadata, and actual request on the
    // same value. A saved preference cannot replace a shell export until the
    // next process starts without that export.
    setSessionReasoningEffort(getConfiguredReasoningEffort());

    return { isShadowedByShell };
  }

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      cancelPendingRunLogRender();
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
    const runStartedAt = performance.now();
    const runMessage = activeUserMessage;
    const runReasoningEffort = sessionReasoningEffort;

    activeRunId.current = runId;
    activeRunCredentialDiagnostics.current = undefined;
    cancelPendingRunLogRender();
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

      const nextLog = appendRunLogEvent(activeRunLog.current, event, nextLogId);
      activeRunLog.current = nextLog;

      // Assistant tokens are retained for the final response, but they do not
      // redraw the live Ink tree. Tool lifecycle events provide the stable,
      // structured progress signal while the model is working.
      if (event.type === "text") {
        return;
      }

      if (activeRunRenderTimer.current !== null) {
        return;
      }

      activeRunRenderTimer.current = setTimeout(() => {
        activeRunRenderTimer.current = null;

        if (!mountedRef.current || activeRunId.current !== runId) {
          return;
        }

        setRunState((currentState) =>
          currentState.status === "running"
            ? {
                ...currentState,
                log: activeRunLog.current,
              }
            : currentState,
        );
      }, RUN_LOG_RENDER_DELAY_MS);
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

        cancelPendingRunLogRender();
        const durationMs = performance.now() - runStartedAt;
        setRunState({
          status: "success",
          result,
          log: activeRunLog.current,
          durationMs,
          credentialDiagnostics: activeRunCredentialDiagnostics.current,
        });
        setCompletedRuns((runs) => [
          ...runs,
          {
            id: nextCompletedRunId.current,
            command: result.command,
            credentialDiagnostics: activeRunCredentialDiagnostics.current,
            durationMs,
            log: activeRunLog.current,
            message: runMessage,
            reasoningEffort: runReasoningEffort,
            result,
          },
        ]);
        nextCompletedRunId.current += 1;
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || activeRunId.current !== runId) {
          return;
        }

        cancelPendingRunLogRender();
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
    sessionReasoningEffort,
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
          setSessionReasoningEffort(getConfiguredReasoningEffort());

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
          durationMs={runState.durationMs}
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
          currentReasoningEffort={sessionReasoningEffort}
          onClear={clearSession}
          onCommandRun={submitCommandRun}
          onModelSelect={selectModel}
          onProviderSelect={selectProvider}
          onReasoningEffortSelect={selectReasoningEffort}
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
        currentReasoningEffort={sessionReasoningEffort}
        onClear={clearSession}
        onCommandRun={submitCommandRun}
        onModelSelect={selectModel}
        onProviderSelect={selectProvider}
        onReasoningEffortSelect={selectReasoningEffort}
        onSubmit={submitChatMessage}
      />
    </Box>
  );
}
