import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { scheduler } from "node:timers/promises";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatBedrockConverse } from "@langchain/aws";
import { ChatGoogle } from "@langchain/google/node";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { ChatOpenAI } from "@langchain/openai";
import { ChatOpenRouter } from "@langchain/openrouter";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { Event as ProtocolEvent } from "@langchain/protocol";
import {
  CompositeBackend,
  createDeepAgent,
  FilesystemBackend,
  type FilesystemPermission,
  type GlobResult,
} from "deepagents";
import { createOpenWikiConnectorTools } from "../connectors/tools.js";
import { createClaimsIntegration } from "../claims/brains/code/integration.js";
import {
  prepareClaimsRuntime,
  type ClaimsRuntime,
} from "../claims/brains/code/runtime.js";
import {
  DEBUG_ENV_KEYS,
  loadOpenWikiEnv,
  openWikiEnvDir,
  saveOpenWikiEnv,
} from "../config/env.js";
import { isFileNotFoundError } from "../platform/fs-errors.js";
import {
  sanitizeDiagnosticText,
  SECRET_KEY_PATTERN_SOURCE,
} from "../platform/diagnostics.js";
import {
  openWikiConversationHistoryDir,
  openWikiHomeDisplayPath,
  openWikiLocalWikiDir,
  openWikiSkillsDir,
} from "../config/openwiki-home.js";
import { resolveLanguage } from "../platform/language.js";
import {
  resolveConceptTypeLabel,
  resolveIndexLabels,
} from "../okf/index-labels.js";
import { OpenWikiLocalShellBackend } from "./docs-only-backend.js";
import { getSelectedModelAvailability } from "../model-availability.js";
import { createOpenWikiAuthoringPoolMiddleware } from "./authoring-pool.js";
import {
  createOpenWikiPlanLedgerMiddleware,
  planReadiness,
} from "./plan-ledger.js";
import { createPlanStore } from "./plan-store.js";
import {
  createOpenWikiVerificationMiddleware,
  createQaGate,
} from "./wiki-verification.js";
import { createOpenWikiCodeInterpreterMiddleware } from "./code-interpreter.js";
import { createOpenWikiGeneralPurposeGuardMiddleware } from "./general-purpose-guard.js";
import { createOpenWikiIndexMiddleware } from "./okf-middleware.js";
import {
  createWikiTranslationMiddleware,
  resolveTranslationPlan,
} from "./translation-middleware.js";
import {
  CODEX_ORIGINATOR,
  CODEX_RESPONSES_BASE_URL,
  codexTokensToEnv,
  createCodexFetch,
  isChatGptTokenExpired,
  readCodexTokensFromEnv,
  refreshChatGptTokens,
} from "./openai-chatgpt-oauth.js";
import { createSystemPrompt, createUserPrompt } from "./prompt.js";
import { resolveRepositoryReviewSubagents } from "./review-subagents.js";
import { resolvePageAuthorSubagents } from "./page-author.js";
import { syncBundledSkills } from "./skills.js";
import {
  createVertexAuthFetch,
  resolveVertexSurface,
  stripPublisherPath,
  toVertexPublisherModel,
  vertexOpenAIBaseUrl,
  withAnthropicAuthEnvNeutralized,
} from "./vertex-surface.js";
import type {
  OpenWikiCommand,
  OpenWikiOutputMode,
  OpenWikiRunEvent,
  OpenWikiRunOptions,
  OpenWikiRunResult,
  RunContext,
} from "./types.js";
import {
  ANTHROPIC_BASE_URL_ENV_KEY,
  BASETEN_BASE_URL_ENV_KEY,
  BEDROCK_AWS_ACCESS_KEY_ID_ENV_KEY,
  BEDROCK_AWS_REGION_ENV_KEY,
  BEDROCK_AWS_SECRET_ACCESS_KEY_ENV_KEY,
  BEDROCK_AWS_SESSION_TOKEN_ENV_KEY,
  COPILOT_BASE_URL_ENV_KEY,
  DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS,
  getDefaultModelId,
  getMissingProviderEnvKey,
  getProviderApiKeyEnvKey,
  getProviderBaseUrlEnvKey,
  getProviderCredentialHint,
  getProviderLabel,
  getProviderBaseUrlWarnings,
  getProviderModelOptions,
  FIREWORKS_BASE_URL_ENV_KEY,
  getProviderRegionEnvKeys,
  getProviderSecretKeyEnvKey,
  getProvidersForKnownModelId,
  isModelIdForOtherProvider,
  DEFAULT_VERTEX_LOCATION,
  GOOGLE_CLOUD_PROJECT_ENV_KEY,
  isValidModelId,
  normalizeModelId,
  NVIDIA_BASE_URL_ENV_KEY,
  OPENAI_BASE_URL_ENV_KEY,
  OPENAI_COMPATIBLE_BASE_URL_ENV_KEY,
  OPENAI_COMPATIBLE_STREAMING_ENV_KEY,
  OPENROUTER_API_KEY_ENV_KEY,
  OPENROUTER_BASE_URL,
  OPENWIKI_MAX_OUTPUT_TOKENS_ENV_KEY,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_OPENROUTER_MAX_TOKENS_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
  OPENWIKI_PROVIDER_RETRY_ATTEMPTS_ENV_KEY,
  OPENWIKI_STREAM_IDLE_TIMEOUT_ENV_KEY,
  providerRequiresBaseUrl,
  providerRequiresRegion,
  providerRequiresSecretKey,
  providerUsesAwsSdkCredentials,
  providerUsesExternalCliAuth,
  providerUsesResponsesApi,
  providerUsesStreaming,
  resolveConfiguredMaxOutputTokens,
  resolveConfiguredProvider,
  resolveOpenAiCompatibleStreamMessages,
  resolveOpenRouterMaxTokens,
  resolveOpenRouterProviderOnly,
  resolveProviderBaseUrl,
  resolveProviderLocation,
  resolveProviderRegion,
  resolveProviderRetryAttempts,
  resolveStreamIdleTimeoutForProvider,
  type OpenWikiProvider,
} from "../config/constants.js";
import { resolveReasoningConfig } from "../config/reasoning.js";
import {
  resolveExternalCliCredential,
  validateExternalCliCredential,
} from "../auth/external-cli-auth.js";
import {
  createOpenWikiContentSnapshot,
  getUpdateNoopStatus,
  createRunContext,
  persistRunMetadataIfChanged,
  removeTemporaryWorkingFiles,
  shouldCheckUpdateNoop,
  writeLastUpdateMetadata,
} from "./utils.js";
import { clearActiveRun, registerActiveRun } from "./crash-guard.js";
import { inStage, inStageSync, tagErrorStage } from "../telemetry/index.js";
import type { RunTelemetryContext } from "../telemetry/index.js";
import { OpenWikiIgnore } from "./openwiki-ignore.js";

export async function runOpenWikiAgent(
  command: OpenWikiCommand,
  cwd = openWikiLocalWikiDir,
  options: OpenWikiRunOptions = {},
  telemetryContext: RunTelemetryContext = {},
): Promise<OpenWikiRunResult> {
  const outputMode = options.outputMode ?? "local-wiki";
  const runtimeCwd = options.outputMode ? cwd : openWikiLocalWikiDir;
  const runTimestamp = new Date().toISOString();

  emitDebug(options, `command=${command}`);
  emitDebug(options, `cwd=${runtimeCwd}`);
  emitDebug(
    options,
    `userMessage=${options.userMessage ? "provided" : "not-provided"}`,
  );
  emitDebug(options, `userMessage.followup=${options.isFollowup === true}`);
  emitDebug(options, `env.beforeLoad ${formatEnvironmentDebug()}`);

  await loadOpenWikiEnv();
  await syncBundledSkills();
  emitDebug(options, `env=loaded ${openWikiHomeDisplayPath}/.env`);
  emitDebug(options, `env.afterLoad ${formatEnvironmentDebug()}`);

  const openWikiIgnore =
    outputMode === "repository"
      ? await OpenWikiIgnore.load(runtimeCwd)
      : new OpenWikiIgnore([]);
  emitDebug(
    options,
    `openwikiignore.patterns=${openWikiIgnore.patterns.length}`,
  );

  const claimsRuntime = await inStage(
    "build",
    () =>
      prepareClaimsRuntime(
        command,
        outputMode,
        runtimeCwd,
        openWikiIgnore,
        (message) => emitClaimsWarning(options, message),
      ),
    { errorClass: "build_error", errorDetail: "claims_preflight" },
  );
  emitDebug(
    options,
    claimsRuntime
      ? `claims.issues=${claimsRuntime.issueCount}`
      : "claims=disabled",
  );

  if (command === "update" && shouldCheckUpdateNoop(options)) {
    const noopStatus = await getUpdateNoopStatus(
      runtimeCwd,
      openWikiIgnore,
      options.language,
    );

    if (noopStatus.shouldSkip) {
      await claimsRuntime?.finalize(runTimestamp);
      const message =
        "No repository changes detected since the last OpenWiki update; skipping agent run.";
      emitDebug(options, `update.noop gitHead=${noopStatus.gitHead}`);
      options.onEvent?.({ type: "text", text: message });

      // Refresh .last-update.json even on a fast-skip no-op so freshness
      // checks reflect the actual last run, not the last content change.
      // The persisted language is carried through so a non-English wiki keeps
      // its marker; dropping it would make the next real update revert to "en".
      try {
        await writeLastUpdateMetadata(
          command,
          cwd,
          noopStatus.model ?? "",
          options.outputMode ?? "local-wiki",
          "complete",
          noopStatus.language,
        );
      } catch {
        // Best-effort: a metadata refresh must never block the no-op path.
      }

      // The single telemetry boundary (withRunTelemetry) owns the record; publish
      // the short-circuit outcome and provider onto the shared context and return.
      telemetryContext.provider = resolveConfiguredProvider();
      telemetryContext.outcome = "noop";

      return {
        command,
        model: noopStatus.model,
        skipped: true,
      };
    }

    emitDebug(options, `update.noop=false reason=${noopStatus.reason}`);
  } else if (command === "update") {
    emitDebug(options, "update.noop=false reason=user message provided");
  }

  const debugFetchCapture = installOpenRouterDebugFetch(options);

  try {
    // Published onto the shared context the instant the provider is resolved, so a
    // failure later in the run still attributes the provider. It stays undefined
    // only if the very first resolution step throws. The single telemetry boundary
    // (withRunTelemetry) reads this context to record the run.
    const config = await resolveRunConfig(options, (resolved) => {
      telemetryContext.provider = resolved;
    });

    return await runOpenWikiAgentCore(
      command,
      runtimeCwd,
      options,
      config.provider,
      config.modelId,
      config.providerRetryAttempts,
      config.maxOutputTokens,
      config.streamIdleTimeout,
      openWikiIgnore,
      claimsRuntime,
      runTimestamp,
    );
  } catch (error) {
    // Enrich the error for the CLI's debug/auth UI, then rethrow. The telemetry
    // record is owned by withRunTelemetry, which reads the stage/class tags this
    // error already carries.
    attachOpenRouterDebugInfo(error, debugFetchCapture.getLastFailure());

    throw error;
  } finally {
    debugFetchCapture.restore();
  }
}

/**
 * Resolves everything the run needs before the agent is built: provider,
 * credentials, model id, and retry count. Any throw here is tagged `config` so
 * the failure telemetry locates it to the resolution stage. `onProviderResolved`
 * fires the moment the provider is known, letting the caller attribute a failure
 * that happens later in resolution to the right provider.
 */
async function resolveRunConfig(
  options: OpenWikiRunOptions,
  onProviderResolved: (provider: OpenWikiProvider) => void,
): Promise<{
  provider: OpenWikiProvider;
  modelId: string;
  providerRetryAttempts: number;
  maxOutputTokens: number | undefined;
  streamIdleTimeout: number | undefined;
}> {
  try {
    const provider = resolveConfiguredProvider();
    onProviderResolved(provider);

    const providerBaseUrl = resolveProviderBaseUrl(provider);
    emitDebug(options, `provider=${provider}`);
    if (providerBaseUrl) {
      emitDebug(
        options,
        `provider.baseUrl=${formatUrlDebugValue(providerBaseUrl)}`,
      );
    }
    await resolveExternalCliCredential(provider);
    const providerApiKey = getProviderApiKey(provider);
    if (providerUsesExternalCliAuth(provider) && providerApiKey) {
      validateExternalCliCredential(provider, providerApiKey);
    }
    ensureProviderCredentials(provider);
    emitDebug(
      options,
      providerUsesAwsSdkCredentials(provider)
        ? `credentials=${provider} delegated-to-aws-sdk`
        : `credentials=${provider} present`,
    );
    ensureProviderBaseUrl(provider);
    ensureProviderSecretKey(provider);
    ensureProviderRegion(provider);

    if (provider === "openai-chatgpt") {
      // Refresh before the model is built, so `createModel` stays synchronous.
      await ensureFreshChatGptTokens();
      emitDebug(options, "chatgpt.token=fresh");
    }

    const modelId = resolveModelId(options, provider);
    emitDebug(options, `model=${modelId}`);
    const modelAvailability = await getSelectedModelAvailability({
      provider,
      modelId,
      apiKey: getProviderApiKey(provider),
      baseUrl: providerBaseUrl,
    });
    if (modelAvailability.status === "unavailable") {
      throw new Error(
        `${getProviderLabel(provider)} does not make model "${modelId}" available to the configured credentials. Set ${OPENWIKI_MODEL_ID_ENV_KEY} to an available model.`,
      );
    }
    if (modelAvailability.status === "unknown") {
      emitDebug(
        options,
        `model.availability=unknown${
          modelAvailability.reason ? ` reason=${modelAvailability.reason}` : ""
        }`,
      );
    }
    const providerRetryAttempts = resolveProviderRetryAttempts();
    emitDebug(options, `provider.retryAttempts=${providerRetryAttempts}`);
    const maxOutputTokens = resolveConfiguredMaxOutputTokens(provider);
    emitDebug(
      options,
      `model.maxOutputTokens=${maxOutputTokens ?? "provider-default"}`,
    );
    const streamIdleTimeout = resolveStreamIdleTimeoutForProvider(provider);
    emitDebug(
      options,
      `model.streamIdleTimeout=${streamIdleTimeout ?? "provider-default"}`,
    );

    return {
      provider,
      modelId,
      providerRetryAttempts,
      maxOutputTokens,
      streamIdleTimeout,
    };
  } catch (error) {
    tagErrorStage(error, "config");
    throw error;
  }
}

export type OpenWikiAgentOptions = {
  command: OpenWikiCommand;
  cwd: string;
  language?: string | null;
  model: BaseChatModel;
  onEvent?: (event: OpenWikiRunEvent) => void;
  outputMode: OpenWikiOutputMode;
};

/**
 * Creates an OpenWiki DeepAgent graph from an already-initialized chat model.
 *
 * This low-level factory prepares runtime state but does not own persisted run
 * metadata or successful-run Claims finalization. Use {@link runOpenWikiAgent}
 * for the complete persisted run boundary.
 *
 * @param options - Initialized model and graph options.
 * @returns Configured OpenWiki agent graph.
 */
export async function createOpenWikiAgent(
  options: OpenWikiAgentOptions,
): Promise<ReturnType<typeof createDeepAgent>> {
  if (!path.isAbsolute(options.cwd)) {
    throw new Error("OpenWiki agent cwd must be an absolute path.");
  }

  await syncBundledSkills();
  const openWikiIgnore =
    options.outputMode === "repository"
      ? await OpenWikiIgnore.load(options.cwd)
      : new OpenWikiIgnore([]);
  const context = await createRunContext(
    options.cwd,
    options.outputMode,
    options.language,
  );
  const claimsRuntime = await prepareClaimsRuntime(
    options.command,
    options.outputMode,
    options.cwd,
    openWikiIgnore,
    (message) => emitClaimsWarning(options, message),
  );
  const checkpointer = await createCheckpointer(
    resolveCheckpointTarget(options.command),
  );

  return createOpenWikiAgentGraph({
    ...options,
    checkpointer,
    context,
    openWikiIgnore,
    claimsRuntime,
    runTimestamp: new Date().toISOString(),
  });
}

type OpenWikiAgentGraphOptions = OpenWikiAgentOptions & {
  /**
   * SQLite graph checkpointer.
   */
  checkpointer: SqliteSaver;

  /**
   * Persisted run context.
   */
  context: RunContext;

  /**
   * Active repository read boundary.
   */
  openWikiIgnore: OpenWikiIgnore;

  /**
   * Repository Claims state for init/update.
   *
   * @default undefined for chat and personal-brain runs.
   */
  claimsRuntime?: ClaimsRuntime;

  /**
   * Single provenance time shared by generated and verified events.
   */
  runTimestamp: string;
};

function createOpenWikiAgentGraph(
  options: OpenWikiAgentGraphOptions,
): ReturnType<typeof createDeepAgent> {
  const wikiBackend = new OpenWikiLocalShellBackend({
    docsOnly: options.command !== "chat",
    openWikiIgnore: options.openWikiIgnore,
    maxOutputBytes: 100_000,
    outputMode: options.outputMode,
    rootDir: options.cwd,
    timeout: 120,
    virtualMode: true,
  });
  const backend = createAgentBackend(wikiBackend);
  // One gate shared by verify_wiki and finalize_wiki. OPENWIKI_QA_MODE=off
  // turns semantic QA into a no-op that still finalizes, which is the control
  // arm for measuring whether it earns its cost.
  // One plan, shared by the tool that accepts it and the tools that consume it.
  const planStore = createPlanStore();
  const qaGate = createQaGate(
    process.env.OPENWIKI_QA_MODE === "off" ? "off" : "full",
  );
  const claimsIntegration = options.claimsRuntime
    ? createClaimsIntegration(options.claimsRuntime, wikiBackend)
    : undefined;
  const claimsSession = options.claimsRuntime?.session;
  // An update inherits the wiki's persisted language unless --language requests a
  // different one. The plan drives a beforeAgent pass that, on a switch,
  // retranslates every page so the incremental update does not leave a mix of the
  // old and new language, and on any update retries pages a prior run left
  // pending. It is undefined for init and chat, which never translate.
  const translation = resolveTranslationPlan(
    options.command,
    resolveLanguage(options.language).language,
    options.context.lastUpdate?.language,
  );
  // Localized headings for the deterministic directory indexes, plus the
  // localized fallback `type` stamped on pages the code has to repair. Both fall
  // back to English for any language not in the static maps.
  const indexLabels = resolveIndexLabels(options.context.language);
  const conceptType = resolveConceptTypeLabel(options.context.language);
  // The caller supplies one stamp time for the whole run, shared by generated
  // provenance here and Claims verification at successful-run finalization.
  return createDeepAgent({
    model: options.model,
    tools: [
      ...createOpenWikiConnectorTools(options.outputMode),
      ...(claimsIntegration?.tools ?? []),
    ],
    checkpointer: options.checkpointer,
    backend,
    middleware:
      options.command === "chat"
        ? []
        : [
            ...(translation
              ? [
                  createWikiTranslationMiddleware(
                    wikiBackend,
                    options.outputMode,
                    options.model,
                    translation,
                    (message) => {
                      options.onEvent?.({ type: "text", text: message });
                      // Also emit to stderr so the warning survives the TUI
                      // re-render and --print's discard of streamed text.
                      process.stderr.write(`${message}\n`);
                    },
                    // The pass announces itself with one line in place of the
                    // suppressed per-token translation output. It is routine
                    // progress, so unlike a warning it is not mirrored to stderr.
                    // The trailing blank line keeps it a distinct Markdown block:
                    // the TUI coalesces consecutive text events into one
                    // block-lexed log item, so without it the status would run
                    // straight into the agent's first streamed line.
                    (message) => {
                      options.onEvent?.({
                        type: "text",
                        text: `${message}\n\n`,
                      });
                    },
                    options.claimsRuntime?.session,
                  ),
                ]
              : []),
            // Exploration and fan-out move inside the REPL, so the
            // orchestrator's turn count stops scaling with repository size.
            createOpenWikiCodeInterpreterMiddleware(),
            // Registered after it, because the REPL reads its ptc list from
            // request.tools and author_pages has to be on the request by then.
            ...(options.command === "init" &&
            options.outputMode === "repository"
              ? [
                  // Scoped here because this is where the named subagents are:
                  // an update or a local-wiki run has general-purpose and
                  // nothing else, and refusing it there would leave `task()`
                  // with no target rather than a better one. Position in this
                  // list does not matter - the guard patches the shared task
                  // tool rather than the request.
                  createOpenWikiGeneralPurposeGuardMiddleware(),
                  createOpenWikiAuthoringPoolMiddleware(
                    planStore,
                    () => planReadiness(planStore, wikiBackend),
                    options.claimsRuntime?.session,
                  ),
                  // Enumeration, the ledger it feeds, and the gate that reads
                  // the ledger: breadth stops being something the workflow asks
                  // for and becomes something it cannot skip.
                  createOpenWikiVerificationMiddleware(qaGate),
                  createOpenWikiPlanLedgerMiddleware(
                    wikiBackend,
                    planStore,
                    qaGate,
                  ),
                ]
              : []),
            ...(claimsIntegration?.middleware ?? []),
            createOpenWikiIndexMiddleware(
              wikiBackend,
              options.outputMode,
              indexLabels,
              conceptType,
              options.runTimestamp,
              claimsSession
                ? () => claimsSession.getEvidenceResourcesByPage()
                : undefined,
            ),
          ],
    skills: ["/skills/"],
    subagents: [
      ...resolveRepositoryReviewSubagents(
        options.command,
        options.outputMode,
        backend,
      ),
      // Authoring is the run's dominant cost and the only phase that cannot move
      // into the REPL, so it scales by fanning out instead.
      ...(options.claimsRuntime
        ? resolvePageAuthorSubagents(
            options.command,
            options.outputMode,
            backend,
            options.claimsRuntime.session,
          )
        : []),
    ],
    permissions: AGENT_FILESYSTEM_PERMISSIONS,
    systemPrompt: createSystemPrompt(
      options.command,
      options.outputMode,
      options.context.language,
      options.openWikiIgnore,
    ),
  });
}

async function runOpenWikiAgentCore(
  command: OpenWikiCommand,
  cwd: string,
  options: OpenWikiRunOptions,
  provider: OpenWikiProvider,
  modelId: string,
  providerRetryAttempts: number,
  maxOutputTokens: number | undefined,
  streamIdleTimeout: number | undefined,
  openWikiIgnore: OpenWikiIgnore,
  claimsRuntime: ClaimsRuntime | undefined,
  runTimestamp: string,
): Promise<OpenWikiRunResult> {
  const outputMode = options.outputMode ?? "local-wiki";
  const context = await inStage(
    "build",
    () => createRunContext(cwd, outputMode, options.language),
    { errorClass: "build_error", errorDetail: "run_context" },
  );
  emitDebug(options, "context=created");
  const openWikiSnapshotBefore =
    command === "chat"
      ? null
      : await inStage(
          "build",
          () => createOpenWikiContentSnapshot(cwd, outputMode),
          { errorClass: "build_error", errorDetail: "snapshot" },
        );
  emitDebug(options, "openwiki.snapshot=created");
  const model = inStageSync(
    "build",
    () =>
      createModel(
        provider,
        modelId,
        providerRetryAttempts,
        maxOutputTokens,
        streamIdleTimeout,
      ),
    { errorClass: "build_error", errorDetail: "model" },
  );
  emitDebug(options, `model.provider=${provider}`);
  emitDebug(options, "model=initialized");
  const threadId = options.threadId ?? createThreadId(cwd, createRunThreadId());
  emitDebug(options, `thread=${threadId}`);
  const checkpointTarget = resolveCheckpointTarget(command);
  const checkpointer = await inStage(
    "build",
    () => createCheckpointer(checkpointTarget),
    { errorClass: "checkpointer_error", errorDetail: "create" },
  );
  emitDebug(
    options,
    checkpointTarget.persistent
      ? `checkpointer=${formatUrlDebugValue(checkpointTarget.connString)}`
      : "checkpointer=memory",
  );
  const agent = inStageSync(
    "build",
    () =>
      createOpenWikiAgentGraph({
        command,
        cwd,
        language: options.language,
        model,
        onEvent: options.onEvent,
        outputMode,
        checkpointer,
        context,
        openWikiIgnore,
        claimsRuntime,
        runTimestamp,
      }),
    { errorClass: "build_error", errorDetail: "agent" },
  );
  emitDebug(options, "agent=created");

  const input = {
    messages: [
      {
        role: "user",
        content: createRunUserMessage(command, cwd, context, options),
      },
    ],
  };

  // "messages" stream mode forces @langchain/core to route the model's
  // `.invoke()` through chunk aggregation. Providers that stream reasoning
  // deltas before the first `role: "assistant"` delta (z.ai GLM) aggregate to
  // a ChatMessageChunk, which the agent loop's wrapModelCall validator
  // rejects: `expected AIMessage or Command, got object` (issue #659). The
  // openai-compatible provider can point at any endpoint, so it gets the
  // safe "updates" mode by default; known-good endpoints can opt back in
  // with OPENWIKI_OPENAI_COMPATIBLE_STREAM_MESSAGES=true.
  const streamMessagesEnabled =
    provider !== "openai-compatible" || resolveOpenAiCompatibleStreamMessages();
  const streamModes = streamMessagesEnabled
    ? (["messages", "tools"] as const)
    : (["updates", "tools"] as const);
  const streamModesLabel = streamModes.join(",");
  emitDebug(options, `stream=opening modes=${streamModesLabel} subgraphs=true`);
  const stream = await inStage(
    "build",
    () =>
      agent.stream(input, {
        configurable: {
          thread_id: threadId,
        },
        streamMode: [...streamModes],
        subgraphs: true,
      }),
    { errorClass: "build_error", errorDetail: "stream_open" },
  );
  emitDebug(options, `stream=started modes=${streamModesLabel} subgraphs=true`);

  // Register with the crash guard for exactly the stream-consumption window so
  // escaped runtime failures become interrupted-stamped runs instead of silent
  // process aborts. The finally clears the registration after every run.
  registerActiveRun({
    command,
    cwd,
    modelId,
    outputMode,
    snapshotBefore: openWikiSnapshotBefore ?? undefined,
    language: context.language,
  });

  let unhandledChunkCount = 0;

  try {
    for await (const chunk of stream) {
      const event = parseAgentStreamChunk(chunk);

      if (event) {
        options.onEvent?.(event);
        // React batches updates from the async iterator; yield so Ink can paint
        // streamed text before the iterator completes.
        await scheduler.yield();
      } else if (options.debug && unhandledChunkCount < 3) {
        emitDebug(
          options,
          `stream.unhandledChunk ${describeStreamChunkShape(chunk)}`,
        );
        unhandledChunkCount += 1;
      }
    }
    emitDebug(options, "stream=completed");
  } catch (error) {
    tagErrorStage(error, "run");

    await cleanupTemporaryWorkingFiles(command, cwd, outputMode, options).catch(
      () => {
        emitDebug(options, "working-files.cleanup=failed");
      },
    );

    // Persist metadata even when the stream fails late, so content that was
    // already generated stays diffable by future updates. The run is recorded
    // as interrupted so the next update is not skipped as a no-op against a
    // possibly partial wiki. Persistence errors are swallowed here so the
    // original run error propagates.
    try {
      const metadataWritten = await persistRunMetadataIfChanged(
        command,
        cwd,
        modelId,
        outputMode,
        openWikiSnapshotBefore,
        "interrupted",
        context.language,
      );
      emitDebug(
        options,
        metadataWritten ? "metadata=written" : "metadata=skipped",
      );
    } catch {
      emitDebug(options, "metadata=writeFailed");
    }

    throw error;
  } finally {
    clearActiveRun();
    prunePersistentCheckpointHistory(
      checkpointTarget,
      checkpointer,
      threadId,
      options,
    );
  }

  if (checkpointTarget.persistent) {
    // Locking down the checkpoint file is a checkpointer concern; a filesystem
    // failure here owns to us, not the user, so it carries its own class rather
    // than the stage-only tag the metadata write below relies on.
    await inStage(
      "finalize",
      () => chmodIfExists(checkpointTarget.connString, 0o600),
      { errorClass: "checkpointer_error", errorDetail: "chmod" },
    );
  }

  // Stage-only tag: a write failure here classifies from the raw error (a
  // filesystem code becomes filesystem_error), and deriveOwner's finalize
  // exception routes that to openwiki since the run reached our own persistence.
  let metadataWritten: boolean;

  try {
    metadataWritten = await inStage("finalize", async () => {
      await cleanupTemporaryWorkingFiles(command, cwd, outputMode, options);
      await claimsRuntime?.finalize(runTimestamp);
      return persistRunMetadataIfChanged(
        command,
        cwd,
        modelId,
        outputMode,
        openWikiSnapshotBefore,
        "complete",
        context.language,
      );
    });
  } catch (error) {
    try {
      await persistRunMetadataIfChanged(
        command,
        cwd,
        modelId,
        outputMode,
        openWikiSnapshotBefore,
        "interrupted",
        context.language,
      );
    } catch {
      emitDebug(options, "metadata=writeFailed");
    }
    throw error;
  }

  if (metadataWritten) {
    emitDebug(options, "metadata=written");
  } else {
    emitDebug(
      options,
      command === "chat"
        ? "metadata=skipped command=chat"
        : "metadata=skipped openwiki=unchanged",
    );
  }

  return {
    command,
    model: modelId,
  };
}

async function cleanupTemporaryWorkingFiles(
  command: OpenWikiCommand,
  cwd: string,
  outputMode: OpenWikiOutputMode,
  options: OpenWikiRunOptions,
): Promise<void> {
  if (command === "chat") {
    return;
  }

  const removed = await removeTemporaryWorkingFiles(cwd, outputMode);
  emitDebug(
    options,
    removed.length > 0
      ? `working-files.cleanup=removed ${removed.join(",")}`
      : "working-files.cleanup=skipped missing",
  );
}

/**
 * Builds the initial user message for a production run.
 *
 * @param command - Current OpenWiki command.
 * @param cwd - Absolute runtime root.
 * @param context - Persisted run context.
 * @param options - User-supplied run options.
 * @param claimsRuntime - Optional repository Claims runtime.
 * @returns Follow-up text or a fully populated command prompt.
 */
function createRunUserMessage(
  command: OpenWikiCommand,
  cwd: string,
  context: Awaited<ReturnType<typeof createRunContext>>,
  options: OpenWikiRunOptions,
): string {
  if (options.isFollowup === true && options.userMessage?.trim()) {
    return options.userMessage.trim();
  }

  return createUserPrompt(
    command,
    context,
    options.userMessage ?? null,
    options.outputMode ?? "local-wiki",
    cwd,
  );
}

const checkpointPath = path.join(openWikiEnvDir, "openwiki.sqlite");

export type CheckpointTarget = {
  connString: string;
  persistent: boolean;
};

/**
 * deepagents' summarization middleware offloads conversation history to
 * `<historyPathPrefix>/<session>.md` through the agent's backend, and
 * `createDeepAgent` exposes no way to override the `"/conversation_history"`
 * default. Keep this mount prefix in sync with that default.
 */
export const CONVERSATION_HISTORY_MOUNT = "/conversation_history/";

/**
 * Agent-layer filesystem permissions. Both virtual mounts are read-only for
 * the model's filesystem tools:
 *
 * - `/skills/**` — skills are installed by the CLI, never by the agent.
 * - `/conversation_history/**` — only the summarization middleware may
 *   write here. It writes directly through the backend, which agent-layer
 *   permissions do not affect, so denying tool writes closes the door on
 *   prompt-injected content being persisted into future sessions' context
 *   without touching the offload itself.
 */
export const AGENT_FILESYSTEM_PERMISSIONS: FilesystemPermission[] = [
  { operations: ["write"], paths: ["/skills/**"], mode: "deny" },
  {
    operations: ["write"],
    paths: [`${CONVERSATION_HISTORY_MOUNT}**`],
    mode: "deny",
  },
];

/**
 * Wraps the wiki backend with the virtual mounts every agent run layers on
 * top of the documented repository (or local wiki):
 *
 * - `/skills/` — the bundled and user skills under ~/.openwiki/skills.
 * - `/conversation_history/` — the summarization middleware's history
 *   offload, routed to ~/.openwiki/conversation_history. Routing it there
 *   keeps the offload out of the documented repository and, on docs-only
 *   init/update runs, keeps the docs-only guard from refusing the write —
 *   that refusal is non-fatal but silently degrades summarization and
 *   narrows coverage on large repositories (#496).
 *
 * `historyDir` and `skillsDir` are injectable for tests.
 */
export function createAgentBackend(
  wikiBackend: OpenWikiLocalShellBackend,
  {
    historyDir = openWikiConversationHistoryDir,
    skillsDir = openWikiSkillsDir,
  }: { historyDir?: string; skillsDir?: string } = {},
): CompositeBackend {
  return new OpenWikiCompositeBackend(wikiBackend, {
    [CONVERSATION_HISTORY_MOUNT]: new FilesystemBackend({
      rootDir: historyDir,
      virtualMode: true,
    }),
    "/skills/": new FilesystemBackend({
      rootDir: skillsDir,
      virtualMode: true,
    }),
  });
}

class OpenWikiCompositeBackend extends CompositeBackend {
  override async glob(pattern: string, path = "/"): Promise<GlobResult> {
    try {
      return await super.glob(pattern, path);
    } catch (error) {
      if (
        error instanceof RangeError &&
        error.message === "Maximum call stack size exceeded"
      ) {
        return {
          error:
            "Glob search was too broad. Retry with a narrower path or pattern.",
        };
      }

      throw error;
    }
  }
}

async function createCheckpointer(
  target: CheckpointTarget,
): Promise<SqliteSaver> {
  if (target.persistent) {
    await prepareCheckpointDirectory(target.connString);
  }

  return SqliteSaver.fromConnString(target.connString);
}

async function prepareCheckpointDirectory(filePath: string): Promise<void> {
  const checkpointDir = path.dirname(filePath);
  await mkdir(checkpointDir, {
    recursive: true,
    mode: 0o700,
  });
  await chmodIfExists(checkpointDir, 0o700);
}

// SqliteSaver.put() only ever inserts new checkpoint rows; nothing in the
// checkpointer itself prunes older ones. A chat session reuses the same
// thread_id for every turn, so the sqlite file grows by a full state
// snapshot on every graph step for as long as the session runs. OpenWiki
// never resumes a chat turn from anything but the latest checkpoint, so
// history beyond that is pure waste and safe to discard here.
export function pruneCheckpointHistory(
  checkpointer: SqliteSaver,
  threadId: string,
): void {
  const prune = checkpointer.db.transaction((id: string) => {
    checkpointer.db
      .prepare(
        `DELETE FROM checkpoints
         WHERE thread_id = ?
           AND (checkpoint_ns, checkpoint_id) NOT IN (
             SELECT checkpoint_ns, checkpoint_id FROM (
               SELECT checkpoint_ns, checkpoint_id,
                      ROW_NUMBER() OVER (
                        PARTITION BY checkpoint_ns ORDER BY checkpoint_id DESC
                      ) AS rank
               FROM checkpoints
               WHERE thread_id = ?
             )
             WHERE rank = 1
           )`,
      )
      .run(id, id);

    checkpointer.db
      .prepare(
        `DELETE FROM writes
         WHERE thread_id = ?
           AND (checkpoint_ns, checkpoint_id) NOT IN (
             SELECT checkpoint_ns, checkpoint_id FROM checkpoints WHERE thread_id = ?
             UNION
             SELECT checkpoint_ns, parent_checkpoint_id FROM checkpoints
             WHERE thread_id = ? AND parent_checkpoint_id IS NOT NULL
           )`,
      )
      .run(id, id, id);
  });

  prune(threadId);
}

function prunePersistentCheckpointHistory(
  checkpointTarget: CheckpointTarget,
  checkpointer: SqliteSaver,
  threadId: string,
  options: OpenWikiRunOptions,
): void {
  if (!checkpointTarget.persistent) {
    return;
  }

  try {
    pruneCheckpointHistory(checkpointer, threadId);
    emitDebug(options, "checkpoint.pruned");
  } catch {
    emitDebug(options, "checkpoint.pruneFailed");
  }
}

export function resolveCheckpointTarget(
  command: OpenWikiCommand,
): CheckpointTarget {
  if (command === "chat") {
    return {
      connString: checkpointPath,
      persistent: true,
    };
  }

  return {
    connString: ":memory:",
    persistent: false,
  };
}

async function chmodIfExists(filePath: string, mode: number): Promise<void> {
  try {
    await chmod(filePath, mode);
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }
}

export function createOpenWikiThreadId(cwd = process.cwd()): string {
  return createThreadId(cwd, createRunThreadId());
}

function createThreadId(cwd: string, runId: string): string {
  const digest = createHash("sha256").update(path.resolve(cwd)).digest("hex");

  return `openwiki-${digest.slice(0, 32)}-${runId}`;
}

function createRunThreadId(): string {
  return `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function emitDebug(options: OpenWikiRunOptions, message: string): void {
  if (!options.debug) {
    return;
  }

  options.onEvent?.({
    type: "debug",
    message,
  });
}

/**
 * Surfaces non-fatal Claims degradation without exposing credential text.
 *
 * @param options - Current run callbacks.
 * @param message - Claims-owned warning detail.
 */
function emitClaimsWarning(
  options: Pick<OpenWikiRunOptions, "onEvent">,
  message: string,
): void {
  const warning = `OpenWiki Claims warning: ${sanitizeDiagnosticText(message)}`;
  try {
    options.onEvent?.({ type: "text", text: `${warning}\n` });
  } catch {
    // A user-owned event callback must not make safe Claims fallback fatal.
  }
  try {
    process.stderr.write(`${warning}\n`);
  } catch {
    // Closed diagnostic streams do not change Claims correctness.
  }
}

function ensureProviderCredentials(provider: OpenWikiProvider): void {
  const missingEnvKey = getMissingProviderEnvKey(provider);

  if (!missingEnvKey) {
    return;
  }

  const hint = getProviderCredentialHint(provider);

  throw new Error(
    `${missingEnvKey} is required to run OpenWiki with ${getProviderLabel(provider)}.${
      hint ? ` ${hint}` : ""
    }`,
  );
}

function ensureProviderBaseUrl(provider: OpenWikiProvider): void {
  const baseUrlEnvKey = getProviderBaseUrlEnvKey(provider) ?? "base URL";
  const baseUrl = resolveProviderBaseUrl(provider);

  if (!baseUrl) {
    if (providerRequiresBaseUrl(provider)) {
      throw new Error(
        `${baseUrlEnvKey} is required to run OpenWiki with ${getProviderLabel(provider)}.`,
      );
    }

    return;
  }

  const warnings = getProviderBaseUrlWarnings(provider, baseUrl);
  if (warnings.length > 0) {
    throw new Error(`${baseUrlEnvKey} is invalid: ${warnings.join(", ")}.`);
  }
}

function ensureProviderSecretKey(provider: OpenWikiProvider): void {
  if (!providerRequiresSecretKey(provider)) {
    return;
  }

  const secretKeyEnvKey = getProviderSecretKeyEnvKey(provider);

  if (secretKeyEnvKey && !process.env[secretKeyEnvKey]) {
    throw new Error(
      `${secretKeyEnvKey} is required to run OpenWiki with ${getProviderLabel(provider)}.`,
    );
  }
}

function ensureProviderRegion(provider: OpenWikiProvider): void {
  if (!providerRequiresRegion(provider)) {
    return;
  }

  if (!resolveProviderRegion(provider)) {
    const regionEnvKeys = getProviderRegionEnvKeys(provider);
    const regionRequirement =
      regionEnvKeys.length > 0 ? regionEnvKeys.join(", ") : "region";

    throw new Error(
      `One of ${regionRequirement} is required to run OpenWiki with ${getProviderLabel(provider)}.`,
    );
  }
}

export function resolveModelId(
  options: OpenWikiRunOptions,
  provider: OpenWikiProvider,
): string {
  const configuredModelId =
    options.modelId ?? process.env[OPENWIKI_MODEL_ID_ENV_KEY];

  if (!configuredModelId && getProviderModelOptions(provider).length === 0) {
    throw new Error(
      `${OPENWIKI_MODEL_ID_ENV_KEY} is required to run OpenWiki with ${getProviderLabel(provider)}.`,
    );
  }

  const modelId = normalizeModelId(
    configuredModelId ?? getDefaultModelId(provider),
  );

  if (!isValidModelId(modelId)) {
    throw new Error(
      `Invalid model ID configured in ${OPENWIKI_MODEL_ID_ENV_KEY}.`,
    );
  }

  warnOnProviderModelMismatch(options, provider, modelId);

  return modelId;
}

// Non-fatal: if the configured model is a known model of a different provider
// (e.g. an Anthropic model left in OPENWIKI_MODEL_ID while the provider is now
// OpenAI), surface an actionable warning instead of letting the request fail
// later with an opaque provider-side 400/404. The run still proceeds, since a
// custom endpoint or gateway may legitimately serve the model.
function warnOnProviderModelMismatch(
  options: OpenWikiRunOptions,
  provider: OpenWikiProvider,
  modelId: string,
): void {
  if (!isModelIdForOtherProvider(modelId, provider)) {
    return;
  }

  const otherProviders = getProvidersForKnownModelId(modelId, provider)
    .map((otherProvider) => getProviderLabel(otherProvider))
    .join(", ");
  const message =
    `Warning: model "${modelId}" is not a known ${getProviderLabel(provider)} model ` +
    `(it belongs to ${otherProviders}). The request may fail. ` +
    `Set ${OPENWIKI_MODEL_ID_ENV_KEY} to a ${getProviderLabel(provider)} model, or switch providers.`;

  emitDebug(options, `model.mismatch provider=${provider} model=${modelId}`);
  options.onEvent?.({ type: "text", text: message });
  // Also emit to stderr so the warning survives on failure, where the TUI
  // re-renders the log away and --print discards buffered streamed text.
  process.stderr.write(`${message}\n`);
}

export function createModel(
  provider: OpenWikiProvider,
  modelId: string,
  providerRetryAttempts: number,
  maxOutputTokens?: number,
  streamIdleTimeout?: number,
) {
  const retryOptions = { maxRetries: providerRetryAttempts };
  const configuredMaxOutputTokens =
    maxOutputTokens ?? resolveConfiguredMaxOutputTokens(provider);
  const maxTokensOptions =
    configuredMaxOutputTokens === undefined
      ? {}
      : { maxTokens: configuredMaxOutputTokens };
  const googleMaxOutputTokensOptions =
    configuredMaxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: configuredMaxOutputTokens };
  const streamIdleTimeoutOptions =
    streamIdleTimeout === undefined ? {} : { streamIdleTimeout };
  const reasoningConfig = resolveReasoningConfig(provider, modelId);

  // GPT-5.6 supports `max` before some OpenAI SDK type unions include it. The
  // documented Responses payload is still `reasoning: { effort }`, so keep the
  // compatibility cast narrowly at the ChatOpenAI constructor boundary.
  const responsesReasoningOptions =
    reasoningConfig?.transport === "responses-reasoning"
      ? { reasoning: { effort: reasoningConfig.effort as never } }
      : {};
  const chatCompletionsReasoningOptions =
    reasoningConfig?.transport === "chat-completions-reasoning-effort"
      ? { modelKwargs: { reasoning_effort: reasoningConfig.effort } }
      : {};

  if (provider === "gemini") {
    return new ChatGoogle({
      apiKey: getProviderApiKey(provider),
      model: modelId,
      platformType: "gai",
      // Gemini 3.x thought-signature round-trip; see the constant's comment.
      ...GEMINI_THOUGHT_SIGNATURE_OPTIONS,
      ...googleMaxOutputTokensOptions,
      ...retryOptions,
    });
  }

  if (provider === "gemini-enterprise") {
    const projectId = process.env[GOOGLE_CLOUD_PROJECT_ENV_KEY];

    if (!projectId) {
      throw new Error(
        `${GOOGLE_CLOUD_PROJECT_ENV_KEY} is required for the gemini-enterprise provider.`,
      );
    }

    // resolveProviderLocation prefers GOOGLE_CLOUD_LOCATION, else the
    // provider's defaultLocation ("global"), so this is always a string.
    const location =
      resolveProviderLocation(provider) ?? DEFAULT_VERTEX_LOCATION;

    return createGeminiEnterpriseModel(
      modelId,
      projectId,
      location,
      retryOptions,
      configuredMaxOutputTokens,
    );
  }

  if (provider === "anthropic") {
    const baseURL = resolveProviderBaseUrl(provider);
    const maxTokens = resolveAnthropicMaxOutputTokens(
      modelId,
      configuredMaxOutputTokens,
    );

    return new ChatAnthropic(modelId, {
      apiKey: getProviderApiKey(provider),
      ...(baseURL ? { anthropicApiUrl: baseURL } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...retryOptions,
    });
  }

  if (provider === "openai-chatgpt") {
    // Already refreshed by `ensureFreshChatGptTokens()` before the run started.
    const tokens = readCodexTokensFromEnv();

    if (!tokens) {
      throw new Error(CHATGPT_LOGIN_INCOMPLETE_MESSAGE);
    }

    // Reuse LangChain's existing ChatOpenAI Responses-API integration (correct
    // tool-calling + SSE parsing for DeepAgents) pointed at the Codex backend:
    // - useResponsesApi routes to POST {baseURL}/responses
    // - zdrEnabled forces `store: false`, which the Codex backend requires
    // - defaultHeaders carry the account id / originator / beta header
    return new ChatOpenAI({
      apiKey: tokens.access,
      model: modelId,
      useResponsesApi: true,
      zdrEnabled: true,
      // The Codex backend rejects non-streaming requests
      // ("Stream must be set to true"), so force the streaming transport for
      // every generation — including the non-streaming `.invoke()` calls
      // DeepAgents' agent node issues internally.
      streaming: true,
      ...maxTokensOptions,
      ...responsesReasoningOptions,
      ...retryOptions,
      configuration: {
        baseURL: CODEX_RESPONSES_BASE_URL,
        defaultHeaders: {
          "chatgpt-account-id": tokens.accountId,
          originator: CODEX_ORIGINATOR,
          "OpenAI-Beta": "responses=experimental",
        },
        fetch: createCodexFetch(modelId),
      },
    });
  }

  if (provider === "openrouter") {
    const providerOnly = resolveOpenRouterProviderOnly();
    const legacyMaxTokens = resolveOpenRouterMaxTokens();
    const effectiveMaxTokens = legacyMaxTokens ?? configuredMaxOutputTokens;

    return new ChatOpenRouter({
      apiKey: process.env[OPENROUTER_API_KEY_ENV_KEY],
      baseURL: OPENROUTER_BASE_URL,
      model: modelId,
      ...(effectiveMaxTokens !== undefined
        ? { maxTokens: effectiveMaxTokens }
        : {}),
      provider: providerOnly ? { only: providerOnly } : undefined,
      siteName: "OpenWiki",
      ...retryOptions,
    });
  }

  if (provider === "bedrock") {
    return new ChatBedrockConverse({
      model: modelId,
      region: resolveProviderRegion(provider),
      ...maxTokensOptions,
      ...streamIdleTimeoutOptions,
      ...retryOptions,
    });
  }

  const baseURL = resolveProviderBaseUrl(provider);

  return new ChatOpenAI({
    apiKey: getProviderApiKey(provider),
    configuration: baseURL
      ? {
          baseURL,
        }
      : undefined,
    model: modelId,
    useResponsesApi: providerUsesResponsesApi(provider, modelId),
    ...maxTokensOptions,
    ...responsesReasoningOptions,
    ...chatCompletionsReasoningOptions,
    // Some gateways only serve the streaming transport; see
    // resolveOpenAiCompatibleStreaming for the full rationale. Spread rather
    // than assigning a boolean: `streaming: false` is not the same as omitting
    // the key, because LangChain turns it into `disableStreaming`.
    ...(providerUsesStreaming(provider) ? { streaming: true } : {}),
    ...retryOptions,
  });
}

const CHATGPT_LOGIN_INCOMPLETE_MESSAGE =
  "ChatGPT login is incomplete. Run `openwiki code --init` or `openwiki personal --init` to sign in with your ChatGPT account.";

/**
 * Refreshes the persisted ChatGPT OAuth tokens once at startup when they are
 * expired/near-expiry, writing the rotated tokens back to `~/.openwiki/.env`
 * (which also updates `process.env`, so `createModel` can stay synchronous).
 * This is a short-lived CLI process, so a single refresh-at-startup is enough:
 * there is no background refresh loop.
 */
async function ensureFreshChatGptTokens(): Promise<void> {
  const tokens = readCodexTokensFromEnv();

  if (!tokens) {
    throw new Error(CHATGPT_LOGIN_INCOMPLETE_MESSAGE);
  }

  if (!isChatGptTokenExpired(tokens.expiresAtMs)) {
    return;
  }

  await saveOpenWikiEnv(
    codexTokensToEnv(await refreshChatGptTokens(tokens.refresh)),
  );
}

function getProviderApiKey(provider: OpenWikiProvider): string | undefined {
  const apiKeyEnvKey = getProviderApiKeyEnvKey(provider);

  return apiKeyEnvKey ? process.env[apiKeyEnvKey] : undefined;
}

// Placeholder OpenAI API key for the Vertex MaaS surface; overwritten per
// request by the auth fetch's Authorization header (see createVertexAuthFetch).
const VERTEX_ADC_PLACEHOLDER_KEY = "vertex-adc";

// Gemini 3.x rejects multi-turn tool calls whose function-call parts lack their
// `thoughtSignature`. LangChain's streaming aggregator (core stream.js)
// unconditionally re-emits the message as v1 standard content blocks, which drop
// that provider-specific signature — so the next turn 400s ("Function call is
// missing a thought_signature"). Disabling streaming routes the call through
// invoke()/generate, which honors outputVersion: "v0" and preserves the raw
// Gemini content parts (signature intact) that the v0 converter round-trips
// correctly. Both ChatGoogle surfaces (AI Studio `gemini` and enterprise Gemini)
// must apply this in lockstep, so it lives in one place.
const GEMINI_THOUGHT_SIGNATURE_OPTIONS = {
  disableStreaming: true,
  outputVersion: "v0",
} as const;

/**
 * Chooses the Anthropic request limit without imposing a modern limit on older
 * or custom Claude models that may expose a smaller output window.
 *
 * LangChain 1.5.1 falls back to 4,096 tokens for model IDs it does not know,
 * including OpenWiki's current Claude 4/5 aliases. OpenWiki raises that default
 * to 16,384 only for modern Claude families. An explicit provider-neutral
 * setting always wins, including for custom model IDs.
 *
 * @param modelId - Direct or Vertex publisher-qualified Anthropic model ID.
 * @param configuredMaxOutputTokens - Explicit OpenWiki setting, when present.
 * @returns The explicit limit, modern-Claude default, or `undefined`.
 */
function resolveAnthropicMaxOutputTokens(
  modelId: string,
  configuredMaxOutputTokens: number | undefined,
): number | undefined {
  if (configuredMaxOutputTokens !== undefined) {
    return configuredMaxOutputTokens;
  }

  const normalizedModelId = stripPublisherPath(modelId);

  return /^claude-(?:haiku|sonnet|opus)-(?:4|5)(?:[-.@]|$)/u.test(
    normalizedModelId,
  )
    ? DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS
    : undefined;
}

/**
 * Builds the right LangChain chat model for a Gemini Enterprise (Vertex AI)
 * model ID. Vertex Model Garden serves different model families over different
 * API surfaces (native Gemini, Anthropic rawPredict, OpenAI-compatible MaaS),
 * each needing a different client. Auth is uniform (ADC + project + region);
 * only the transport differs, keyed off the model ID via resolveVertexSurface.
 */
function createGeminiEnterpriseModel(
  modelId: string,
  projectId: string,
  location: string,
  retryOptions: { maxRetries: number },
  maxOutputTokens?: number,
) {
  const maxTokensOptions =
    maxOutputTokens === undefined ? {} : { maxTokens: maxOutputTokens };
  const googleMaxOutputTokensOptions =
    maxOutputTokens === undefined ? {} : { maxOutputTokens };

  switch (resolveVertexSurface(modelId)) {
    case "anthropic": {
      const maxTokens = resolveAnthropicMaxOutputTokens(
        modelId,
        maxOutputTokens,
      );

      // No JS-native Claude-on-Vertex chat model exists; bridge via
      // ChatAnthropic's `createClient` hook + the Anthropic Vertex SDK, which
      // authenticates through ADC. Providing `createClient` also removes the
      // ANTHROPIC_API_KEY requirement. The env is neutralized around the
      // constructor so a stray ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN cannot
      // clobber the Google OAuth token (see withAnthropicAuthEnvNeutralized).
      //
      // dangerouslyAllowBrowser: the Anthropic SDK (base of AnthropicVertex)
      // refuses to construct when it detects `window`/`document`/`navigator` —
      // its browser-credential-exposure guard. OpenWiki is always a Node CLI/CI
      // process, but the optional Mermaid validation path installs jsdom DOM
      // globals process-wide (see src/mermaid/dom-shim.ts), which trips that
      // guard and aborts the whole run before any docs are generated. ChatAnthropic
      // passes `dangerouslyAllowBrowser: true` into `createClient`, but this hook
      // ignores its argument, so the flag is set explicitly here. It is forwarded
      // to AnthropicVertex only — never the ANTHROPIC_* auth options LangChain
      // also passes, which would defeat withAnthropicAuthEnvNeutralized.
      return new ChatAnthropic(stripPublisherPath(modelId), {
        createClient: () =>
          withAnthropicAuthEnvNeutralized(
            () =>
              new AnthropicVertex({
                projectId,
                region: location,
                dangerouslyAllowBrowser: true,
              }),
          ),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...retryOptions,
      });
    }

    case "openai-maas":
      // Partner/open-weight models (Llama, Mistral, DeepSeek, Qwen, …) are
      // reached over Vertex's OpenAI-compatible endpoint. The bearer token is
      // injected per request by a fetch wrapper (see createVertexAuthFetch);
      // `apiKey` is a placeholder because that header is overwritten.
      return new ChatOpenAI({
        apiKey: VERTEX_ADC_PLACEHOLDER_KEY,
        configuration: {
          baseURL: vertexOpenAIBaseUrl(projectId, location),
          fetch: createVertexAuthFetch(),
        },
        model: toVertexPublisherModel(modelId),
        ...maxTokensOptions,
        ...retryOptions,
      });

    default:
      return new ChatGoogle({
        // Gemini/Gemma over generateContent wants the bare model ID; normalize a
        // fully publisher-pathed ID (publishers/google/models/gemini-…) the same
        // way the anthropic and maas branches normalize theirs.
        model: stripPublisherPath(modelId),
        platformType: "gcp",
        // Gemini 3.x thought-signature round-trip; see the constant's comment.
        ...GEMINI_THOUGHT_SIGNATURE_OPTIONS,
        // Force ADC + project auth. The node client resolves
        // `apiKey ?? GOOGLE_API_KEY`, and when an API key is present it both
        // sends the X-Goog-Api-Key header and flips to Vertex Express mode — so
        // a stray GOOGLE_API_KEY in the environment would silently hijack this
        // enterprise path. An empty string is treated as "no API key"
        // (hasApiKey() checks `!== ""`), which blocks that fallback.
        apiKey: "",
        location,
        // Pass the project explicitly rather than relying on ambient
        // process.env, using the `/node` entrypoint where googleAuthOptions is
        // typed (the default entrypoint types authOptions as `never`).
        googleAuthOptions: { projectId },
        ...googleMaxOutputTokensOptions,
        ...retryOptions,
      });
  }
}

export function parseAgentStreamChunk(chunk: unknown): OpenWikiRunEvent | null {
  if (!isAgentStreamChunk(chunk)) {
    return null;
  }

  const [namespace, mode, payload] = chunk;

  if (mode === "tools") {
    return parseToolStreamEvent(payload);
  }

  const text = extractMessageText(payload);

  return text.length > 0
    ? {
        source: getStreamSource(namespace),
        type: "text",
        text,
      }
    : null;
}

/**
 * Parses the Agent Protocol event shape exposed by the public agent factory.
 */
export function parseStreamEvent(chunk: unknown): OpenWikiRunEvent | null {
  if (!isProtocolStreamEvent(chunk)) {
    return null;
  }

  if (chunk.method === "messages") {
    const text = extractMessageText(chunk.params.data);

    return text.length > 0
      ? {
          source: getStreamSource(chunk.params.namespace),
          type: "text",
          text,
        }
      : null;
  }

  if (chunk.method === "tools") {
    return parseToolStreamEvent(chunk.params.data);
  }

  return null;
}

function isProtocolStreamEvent(value: unknown): value is ProtocolEvent {
  return (
    isRecord(value) &&
    value.type === "event" &&
    typeof value.method === "string" &&
    isRecord(value.params) &&
    "data" in value.params
  );
}

function isAgentStreamChunk(
  value: unknown,
): value is [string[], "messages" | "tools", unknown] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    Array.isArray(value[0]) &&
    value[0].every((part) => typeof part === "string") &&
    (value[1] === "messages" || value[1] === "tools")
  );
}

function extractMessageText(payload: unknown): string {
  return extractMessageTextValue(payload, new Set());
}

function extractMessageTextValue(payload: unknown, seen: Set<object>): string {
  if (typeof payload === "string") {
    return payload;
  }

  if (Array.isArray(payload)) {
    if (payload.length === 2 && isStreamMessageTuplePayload(payload)) {
      return extractMessageTextValue(payload[0], seen);
    }

    for (const item of payload) {
      const text = extractMessageTextValue(item, seen);

      if (text.length > 0) {
        return text;
      }
    }

    return payload.map((item) => extractContentBlockText(item, seen)).join("");
  }

  if (!isRecord(payload) || seen.has(payload)) {
    return "";
  }

  seen.add(payload);

  if (isRecord(payload.chunk)) {
    const text = extractMessageTextValue(payload.chunk, seen);

    if (text.length > 0) {
      return text;
    }
  }

  if (isRecord(payload.message)) {
    const text = extractMessageTextValue(payload.message, seen);

    if (text.length > 0) {
      return text;
    }
  }

  if (!shouldReadMessageRecord(payload)) {
    return "";
  }

  const contentText = extractContentText(payload.content, seen);

  if (contentText.length > 0) {
    return contentText;
  }

  for (const key of [
    "text",
    "output",
    "generations",
    "messages",
    "kwargs",
    "lc_kwargs",
  ]) {
    const text = extractMessageTextValue(payload[key], seen);

    if (text.length > 0) {
      return text;
    }
  }

  return "";
}

function isStreamMessageTuplePayload(payload: unknown[]): boolean {
  const [message, metadata] = payload;

  if (!isRecord(metadata) || !isMessageLikeRecord(message)) {
    return false;
  }

  if (
    "langgraph_node" in metadata ||
    "run_id" in metadata ||
    "tags" in metadata ||
    "metadata" in metadata
  ) {
    return true;
  }

  return (
    "langgraph_node" in message ||
    "checkpoint_ns" in message ||
    "thread_id" in message
  );
}

function isMessageLikeRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  return (
    "content" in value ||
    "text" in value ||
    "kwargs" in value ||
    "lc_kwargs" in value ||
    typeof value._getType === "function" ||
    getMessageRole(value) !== null ||
    hasSerializedMessageId(value)
  );
}

function extractContentText(content: unknown, seen: Set<object>): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((block) => extractContentBlockText(block, seen))
      .join("");
  }

  if (isRecord(content)) {
    return extractContentBlockText(content, seen);
  }

  return "";
}

function extractContentDeltaText(delta: unknown, seen: Set<object>): string {
  if (typeof delta === "string") {
    return delta;
  }

  if (!isRecord(delta)) {
    return "";
  }

  const type = getStringRecordValue(delta, "type");

  if (type === "text-delta") {
    return typeof delta.text === "string" ? delta.text : "";
  }

  if (type === "block-delta") {
    return extractContentBlockText(delta.fields, seen);
  }

  if (typeof delta.text === "string") {
    return delta.text;
  }

  if (typeof delta.delta === "string") {
    return delta.delta;
  }

  return "";
}

function extractContentBlockText(block: unknown, seen: Set<object>): string {
  if (typeof block === "string") {
    return block;
  }

  if (!isRecord(block)) {
    return "";
  }

  const type = getStringRecordValue(block, "type");

  if (
    type?.includes("tool") ||
    type?.includes("reasoning") ||
    type?.includes("file") ||
    type?.includes("image")
  ) {
    return "";
  }

  for (const key of ["text", "content", "output_text"]) {
    const text = block[key];

    if (typeof text === "string") {
      return text;
    }
  }

  if (isRecord(block.fields)) {
    return extractContentBlockText(block.fields, seen);
  }

  if (isRecord(block.delta)) {
    return extractContentDeltaText(block.delta, seen);
  }

  return "";
}

function shouldReadMessageRecord(value: Record<string, unknown>): boolean {
  const role = getMessageRole(value);

  return role === null || role === "ai" || role === "assistant";
}

function getMessageRole(value: Record<string, unknown>): string | null {
  for (const key of ["role", "type"]) {
    const role = getStringRecordValue(value, key);

    if (isMessageRole(role)) {
      return role;
    }
  }

  const serializedType = getSerializedMessageType(value);

  if (serializedType === "AIMessage" || serializedType === "AIMessageChunk") {
    return "ai";
  }

  if (
    serializedType === "HumanMessage" ||
    serializedType === "SystemMessage" ||
    serializedType === "ToolMessage"
  ) {
    return serializedType.replace("Message", "").toLowerCase();
  }

  const getType = value._getType;

  if (typeof getType !== "function") {
    return null;
  }

  try {
    const role: unknown = getType.call(value);

    return isMessageRole(role) ? role : null;
  } catch {
    return null;
  }
}

function hasSerializedMessageId(value: Record<string, unknown>): boolean {
  return getSerializedMessageType(value) !== null;
}

function getSerializedMessageType(
  value: Record<string, unknown>,
): string | null {
  if (!Array.isArray(value.id)) {
    return null;
  }

  return (
    value.id
      .filter((part): part is string => typeof part === "string")
      .at(-1) ?? null
  );
}

function isMessageRole(value: unknown): value is string {
  return (
    value === "ai" ||
    value === "assistant" ||
    value === "human" ||
    value === "system" ||
    value === "tool"
  );
}

function parseToolStreamEvent(payload: unknown): OpenWikiRunEvent | null {
  if (!isRecord(payload)) {
    return null;
  }

  const event = getStringRecordValue(payload, "event");
  const name = getStringRecordValue(payload, "name") ?? "tool";
  const id = getStringRecordValue(payload, "toolCallId") ?? name;

  if (event === "on_tool_start") {
    return {
      type: "tool_start",
      call: sanitizeDiagnosticText(
        `${formatToolCallName(name)}(${formatToolArgs(payload.input)})`,
      ),
      id,
      input: payload.input,
      name,
    };
  }

  if (event === "on_tool_end" || event === "on_tool_error") {
    return {
      type: "tool_end",
      id,
      name,
      status: event === "on_tool_error" ? "error" : "finished",
    };
  }

  return null;
}

/**
 * Classifies a stream namespace. LangGraph reserves the empty namespace for
 * the root graph; even a single namespace segment therefore belongs to a
 * subgraph.
 */
function getStreamSource(namespace: unknown): "main" | "subgraph" {
  return Array.isArray(namespace) && namespace.length > 0 ? "subgraph" : "main";
}

function formatToolCallName(name: string): string {
  return name === "execute" ? "Execute" : name;
}

function formatToolArgs(input: unknown): string {
  const value = parseStringifiedJson(input);

  // Checked ahead of isRecord: arrays are `typeof "object"` and non-null, so
  // the record branch would otherwise claim them and render `0=…, 1=…`.
  if (Array.isArray(value)) {
    return value.map(formatToolValue).join(", ");
  }

  if (isRecord(value)) {
    return Object.entries(value)
      .map(([key, argValue]) => `${key}=${formatToolValue(argValue)}`)
      .join(", ");
  }

  if (value === undefined || value === null) {
    return "";
  }

  return formatToolValue(value);
}

function formatToolValue(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function parseStringifiedJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function getStringRecordValue(
  value: Record<string, unknown>,
  key: string,
): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describeStreamChunkShape(chunk: unknown): string {
  if (Array.isArray(chunk)) {
    return `array(length=${chunk.length}, items=${chunk
      .slice(0, 3)
      .map(describeValueShape)
      .join(",")})`;
  }

  return describeValueShape(chunk);
}

function describeValueShape(value: unknown): string {
  if (Array.isArray(value)) {
    return `array(length=${value.length})`;
  }

  if (isRecord(value)) {
    const keys = Object.keys(value);
    const suffix = keys.length > 8 ? ",..." : "";

    return `object(keys=${keys.slice(0, 8).join(",")}${suffix})`;
  }

  return typeof value;
}

type OpenRouterFetchCapture = {
  clearLastFailure: () => void;
  getLastFailure: () => OpenRouterFetchFailure | null;
  restore: () => void;
};

type OpenRouterFetchFailure = {
  fetchError?: string;
  request: OpenRouterRequestSummary;
  response?: OpenRouterResponseSummary;
};

type OpenRouterRequestSummary = {
  bodyBytes?: number;
  messageChars?: number;
  messageCount?: number;
  method: string;
  model?: string;
  stream?: boolean;
  toolCount?: number;
  toolNames?: string[];
  url: string;
};

type OpenRouterResponseSummary = {
  bodyPreview: string;
  headers: Record<string, string>;
  status: number;
  statusText: string;
};

const OPENROUTER_DEBUG_PROPERTY = "openRouterDebug";
const OPENROUTER_DEBUG_BODY_LIMIT = 4_000;

function installOpenRouterDebugFetch(
  options: OpenWikiRunOptions,
): OpenRouterFetchCapture {
  const originalFetch = globalThis.fetch;
  let lastFailure: OpenRouterFetchFailure | null = null;

  globalThis.fetch = (async (input, init) => {
    if (!isOpenRouterFetchInput(input)) {
      return originalFetch(input, init);
    }

    const request = summarizeOpenRouterRequest(input, init);

    try {
      const response = await originalFetch(input, init);

      if (!response.ok) {
        lastFailure = {
          request,
          response: {
            bodyPreview: await readResponseBodyPreview(response),
            headers: getSafeResponseHeaders(response.headers),
            status: response.status,
            statusText: response.statusText,
          },
        };
        emitDebug(
          options,
          `openrouter.http status=${response.status} statusText=${JSON.stringify(
            response.statusText,
          )}`,
        );
      }

      return response;
    } catch (error) {
      lastFailure = {
        fetchError: error instanceof Error ? error.message : String(error),
        request,
      };
      throw error;
    }
  }) satisfies typeof fetch;

  return {
    clearLastFailure: () => {
      lastFailure = null;
    },
    getLastFailure: () => lastFailure,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function attachOpenRouterDebugInfo(
  error: unknown,
  failure: OpenRouterFetchFailure | null,
): void {
  if (!failure || !isRecord(error)) {
    return;
  }

  error[OPENROUTER_DEBUG_PROPERTY] = failure;
}

function isOpenRouterFetchInput(input: Parameters<typeof fetch>[0]): boolean {
  const url = getFetchInputUrl(input);

  return (
    url !== null &&
    url.startsWith(OPENROUTER_BASE_URL) &&
    url.includes("/chat/completions")
  );
}

function getFetchInputUrl(input: Parameters<typeof fetch>[0]): string | null {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return "url" in input && typeof input.url === "string" ? input.url : null;
}

function summarizeOpenRouterRequest(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): OpenRouterRequestSummary {
  const body = typeof init?.body === "string" ? init.body : null;
  const parsedBody = parseJsonRecord(body);
  const toolNames = getOpenRouterToolNames(parsedBody?.tools);

  return {
    bodyBytes: body === null ? undefined : Buffer.byteLength(body, "utf8"),
    messageChars: getOpenRouterMessageChars(parsedBody?.messages),
    messageCount: Array.isArray(parsedBody?.messages)
      ? parsedBody.messages.length
      : undefined,
    method: init?.method ?? "GET",
    model: typeof parsedBody?.model === "string" ? parsedBody.model : undefined,
    stream:
      typeof parsedBody?.stream === "boolean" ? parsedBody.stream : undefined,
    toolCount: toolNames.length,
    toolNames: toolNames.slice(0, 20),
    url: formatOpenRouterDebugUrl(getFetchInputUrl(input) ?? "unknown"),
  };
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (value === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;

    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getOpenRouterToolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools
    .map((tool) => {
      if (!isRecord(tool) || !isRecord(tool.function)) {
        return null;
      }

      return typeof tool.function.name === "string" ? tool.function.name : null;
    })
    .filter((name): name is string => name !== null);
}

function getOpenRouterMessageChars(messages: unknown): number | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }

  return messages.reduce<number>((total, message) => {
    if (!isRecord(message)) {
      return total;
    }

    return total + countMessageContentChars(message.content);
  }, 0);
}

function countMessageContentChars(content: unknown): number {
  if (typeof content === "string") {
    return content.length;
  }

  if (Array.isArray(content)) {
    return content.reduce<number>(
      (total, block) => total + countMessageContentChars(block),
      0,
    );
  }

  if (!isRecord(content)) {
    return 0;
  }

  return Object.entries(content).reduce((total, [key, value]) => {
    if (key === "text" || key === "content") {
      return total + countMessageContentChars(value);
    }

    return total;
  }, 0);
}

async function readResponseBodyPreview(response: Response): Promise<string> {
  try {
    const body = await response.clone().text();
    const sanitizedBody = sanitizeOpenRouterResponseBody(body);

    return sanitizedBody.length <= OPENROUTER_DEBUG_BODY_LIMIT
      ? sanitizedBody
      : `${sanitizedBody.slice(0, OPENROUTER_DEBUG_BODY_LIMIT - 3)}...`;
  } catch (error) {
    return `Unable to read response body: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

export function sanitizeOpenRouterResponseBody(body: string): string {
  // Redact string values whose JSON key name contains any secret-bearing term
  // (shared source of truth with isSecretLikeKey / the MCP redactor).
  const secretJsonKeyPattern = new RegExp(
    `"([^"]*(?:${SECRET_KEY_PATTERN_SOURCE})[^"]*)"\\s*:\\s*"[^"]*"`,
    "giu",
  );

  return body.replace(
    secretJsonKeyPattern,
    (_, key: string) => `${JSON.stringify(key)}:"[REDACTED]"`,
  );
}

function getSafeResponseHeaders(headers: Headers): Record<string, string> {
  const safeHeaders: Record<string, string> = {};

  for (const key of ["cf-ray", "content-type", "request-id", "x-request-id"]) {
    const value = headers.get(key);

    if (value) {
      safeHeaders[key] = value;
    }
  }

  return safeHeaders;
}

function formatOpenRouterDebugUrl(value: string): string {
  try {
    const url = new URL(value);

    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";

    return url.toString();
  } catch {
    return value;
  }
}

function formatEnvironmentDebug(): string {
  return DEBUG_ENV_KEYS.map(
    (key) => `${key}:${formatEnvironmentDebugValue(key, process.env[key])}`,
  ).join(" ");
}

export function formatEnvironmentDebugValue(
  key: string,
  value: string | undefined,
): string {
  if (value === undefined) {
    return "unset";
  }

  if (
    key === "LANGCHAIN_ENDPOINT" ||
    key === ANTHROPIC_BASE_URL_ENV_KEY ||
    key === BASETEN_BASE_URL_ENV_KEY ||
    key === COPILOT_BASE_URL_ENV_KEY ||
    key === FIREWORKS_BASE_URL_ENV_KEY ||
    key === NVIDIA_BASE_URL_ENV_KEY ||
    key === OPENAI_BASE_URL_ENV_KEY ||
    key === OPENAI_COMPATIBLE_BASE_URL_ENV_KEY
  ) {
    return formatUrlDebugValue(value);
  }

  if (
    key.endsWith("_API_KEY") ||
    key === BEDROCK_AWS_ACCESS_KEY_ID_ENV_KEY ||
    key === BEDROCK_AWS_SECRET_ACCESS_KEY_ENV_KEY ||
    key === BEDROCK_AWS_SESSION_TOKEN_ENV_KEY
  ) {
    return `set(length=${value.length})`;
  }

  if (
    key === OPENWIKI_MODEL_ID_ENV_KEY ||
    key === OPENWIKI_PROVIDER_ENV_KEY ||
    key === OPENWIKI_MAX_OUTPUT_TOKENS_ENV_KEY ||
    key === OPENWIKI_STREAM_IDLE_TIMEOUT_ENV_KEY ||
    key === OPENWIKI_PROVIDER_RETRY_ATTEMPTS_ENV_KEY ||
    key === OPENWIKI_OPENROUTER_MAX_TOKENS_ENV_KEY ||
    key === OPENAI_COMPATIBLE_STREAMING_ENV_KEY ||
    key === BEDROCK_AWS_REGION_ENV_KEY
  ) {
    return `set(value=${JSON.stringify(value)})`;
  }

  if (value.length <= 10) {
    return `set(length=${value.length})`;
  }

  return `set(length=${value.length}, preview=${JSON.stringify(
    `${value.slice(0, 6)}...${value.slice(-4)}`,
  )})`;
}

function formatUrlDebugValue(value: string): string {
  try {
    const url = new URL(value);
    const redacted: string[] = [];

    if (url.username || url.password) {
      redacted.push("auth");
      url.username = "";
      url.password = "";
    }

    if (url.search) {
      redacted.push("query");
      url.search = "";
    }

    if (url.hash) {
      redacted.push("hash");
      url.hash = "";
    }

    const redactionSuffix =
      redacted.length > 0 ? `, redacted=${redacted.join("+")}` : "";

    return `set(url=${JSON.stringify(url.toString())}${redactionSuffix})`;
  } catch {
    return `set(length=${value.length}, preview=${JSON.stringify(
      `${value.slice(0, 6)}...${value.slice(-4)}`,
    )})`;
  }
}
