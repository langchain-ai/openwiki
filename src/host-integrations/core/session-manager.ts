import { randomUUID } from "node:crypto";
import { OpenWikiLocalShellBackend } from "../../agent/docs-only-backend.js";
import { OpenWikiIgnore } from "../../agent/openwiki-ignore.js";
import type { RunContext } from "../../agent/types.js";
import { ensureCodeModeRepoSetup } from "../../ingestion/code-mode.js";
import {
  createOpenWikiContentSnapshot,
  createRunContext,
  getUpdateNoopStatus,
  persistRunMetadataIfChanged,
  removeTemporaryWorkingFiles,
  type OpenWikiContentSnapshot,
  type UpdateNoopStatus,
  writeLastUpdateMetadata,
} from "../../agent/utils.js";
import {
  finalizeWikiArtifacts,
  prepareWikiForAuthoring,
  type PreparedWikiState,
} from "../../agent/wiki-finalizer.js";
import {
  resolveConceptTypeLabel,
  resolveIndexLabels,
} from "../../okf/index-labels.js";
import { HostIntegrationError } from "./errors.js";
import {
  BeginInput,
  RunInput,
  type BeginRequest,
  type HostRunMode,
  type ProtocolTool,
  type RunRequest,
} from "./protocol.js";
import { resolveRepositoryRoot } from "./repository-root.js";

const HOST_ID_PATTERN = /^[a-z0-9-]{1,64}$/u;

/**
 * Construction options for one host lifecycle manager.
 */
export interface HostSessionManagerOptions {
  /**
   * Stable lowercase host identifier used in run metadata.
   */
  host: string;

  /**
   * Injectable clock used to make run timestamps deterministic in tests.
   *
   * @default () => new Date()
   */
  now?: () => Date;
}

/**
 * Safe context returned to a host after preparation succeeds.
 */
export interface BeginResult {
  /**
   * Opaque identifier required by the matching finish call.
   */
  runId: string;

  /**
   * Canonical Git repository root locked to this run.
   */
  root: string;

  /**
   * Lifecycle mode selected for this run.
   */
  mode: HostRunMode;

  /**
   * Resolved wiki output language.
   */
  language: string;

  /**
   * Persisted context from the previous run.
   */
  lastUpdate: RunContext["lastUpdate"];

  /**
   * Existing repository wiki goal, when one is available.
   *
   * @default undefined - no prior wiki goal exists.
   */
  wikiGoal?: string;

  /**
   * Update no-op analysis supplied only for update runs.
   *
   * @default undefined - the run is an init.
   */
  updatePreflight?: UpdateNoopStatus;

  /**
   * Number of active `.openwikiignore` patterns.
   */
  ignoredPatterns: number;
}

/**
 * Successful terminal result of a host-authored wiki run.
 */
export interface FinishResult {
  /**
   * Durable lifecycle outcome.
   */
  status: "complete";
}

/**
 * Public, non-sensitive view of one active host run.
 */
export interface HostRunView {
  /**
   * Opaque run identifier.
   */
  id: string;

  /**
   * Canonical repository root.
   */
  root: string;

  /**
   * Stable host identifier.
   */
  host: string;

  /**
   * Lifecycle mode selected for this run.
   */
  mode: HostRunMode;

  /**
   * Resolved wiki output language.
   */
  language: string;

  /**
   * ISO 8601 time at which the run began.
   */
  startedAt: string;
}

/**
 * Private state retained between begin and finish.
 */
interface ActiveSession extends HostRunView {
  /**
   * Guarded documentation filesystem used by deterministic finalizers.
   */
  backend: OpenWikiLocalShellBackend;

  /**
   * Content baseline used by complete-run metadata persistence.
   */
  beforeContentSnapshot: OpenWikiContentSnapshot;

  /**
   * Deterministic state captured immediately before host authoring.
   */
  preparedWiki: PreparedWikiState;
}

/**
 * Owns one in-process begin/finish lifecycle for a host process.
 */
export class HostSessionManager {
  /**
   * Current retryable run, or `null` when no run is active.
   */
  private active: ActiveSession | null = null;

  /**
   * Stable host identifier written to run metadata.
   */
  private readonly host: string;

  /**
   * Clock used to create deterministic run timestamps.
   */
  private readonly now: () => Date;

  /**
   * Creates a rootless manager after host configuration validation.
   *
   * @param host - Stable host identifier.
   * @param now - Run timestamp source.
   */
  private constructor(host: string, now: () => Date) {
    this.host = host;
    this.now = now;
  }

  /**
   * Validates configuration and creates a rootless host manager.
   *
   * @param options - Host ID and optional clock.
   * @returns Validated lifecycle manager.
   */
  static create(options: HostSessionManagerOptions): HostSessionManager {
    if (!HOST_ID_PATTERN.test(options.host)) {
      throw new HostIntegrationError(
        "invalid_input",
        "The host ID must contain lowercase letters, digits, or hyphens.",
      );
    }

    return new HostSessionManager(
      options.host,
      options.now ?? (() => new Date()),
    );
  }

  /**
   * Supersedes any abandoned run, marks metadata interrupted, and prepares the
   * wiki before returning authoring context to the host.
   *
   * @param input - Validated init or update request.
   * @returns Safe run context and opaque run identifier.
   */
  async begin(input: BeginRequest): Promise<BeginResult> {
    this.active = null;

    const runId = randomUUID();
    const runTimestamp = this.now().toISOString();

    try {
      const root = await resolveRepositoryRoot(input.root);
      await ensureCodeModeRepoSetup(root, {
        createWorkflow: input.mode === "init",
      });
      const ignore = await OpenWikiIgnore.load(root);
      const context = await createRunContext(
        root,
        "repository",
        input.language,
      );
      const language = context.language ?? "en";
      const updatePreflight =
        input.mode === "update"
          ? await getUpdateNoopStatus(root, ignore, input.language)
          : undefined;
      const beforeContentSnapshot = await createOpenWikiContentSnapshot(
        root,
        "repository",
      );
      const backend = new OpenWikiLocalShellBackend({
        docsOnly: true,
        maxOutputBytes: 100_000,
        openWikiIgnore: ignore,
        outputMode: "repository",
        rootDir: root,
        timeout: 120,
        virtualMode: true,
      });

      await writeLastUpdateMetadata(
        input.mode,
        root,
        `host-agent/${this.host}`,
        "repository",
        "interrupted",
        language,
      );
      const preparedWiki = await prepareWikiForAuthoring({
        backend,
        outputMode: "repository",
        conceptType: resolveConceptTypeLabel(language),
      });

      this.active = {
        id: runId,
        root,
        host: this.host,
        mode: input.mode,
        language,
        startedAt: runTimestamp,
        backend,
        beforeContentSnapshot,
        preparedWiki,
      };

      return {
        runId,
        root,
        mode: input.mode,
        language,
        lastUpdate: context.lastUpdate,
        wikiGoal: context.wikiGoal,
        updatePreflight,
        ignoredPatterns: ignore.patterns.length,
      };
    } catch (error) {
      this.active = null;
      throw error;
    }
  }

  /**
   * Finalizes the active host-authored wiki and persists complete metadata.
   * The session remains active when any pre-commit step fails, allowing retry.
   *
   * @param input - Validated selector for the active run.
   * @returns Durable completion result.
   */
  async finish(input: RunRequest): Promise<FinishResult> {
    const session = this.requireSession(input.runId);

    await removeTemporaryWorkingFiles(session.root, "repository");
    await finalizeWikiArtifacts({
      backend: session.backend,
      outputMode: "repository",
      labels: resolveIndexLabels(session.language),
      conceptType: resolveConceptTypeLabel(session.language),
      prepared: session.preparedWiki,
      at: session.startedAt,
    });
    await persistRunMetadataIfChanged(
      session.mode,
      session.root,
      `host-agent/${session.host}`,
      "repository",
      session.beforeContentSnapshot,
      "complete",
      session.language,
    );

    this.active = null;
    return { status: "complete" };
  }

  /**
   * Returns the safe view of a matching active run.
   *
   * @param runId - Opaque active run identifier.
   * @returns Public run view without page contents or environment data.
   */
  getRun(runId: string): HostRunView {
    return toView(this.requireSession(runId));
  }

  /**
   * Returns the complete V1 transport-neutral lifecycle tool set.
   *
   * @returns Begin and finish tools bound to this manager.
   */
  tools(): readonly ProtocolTool[] {
    return [
      {
        name: "openwiki_begin",
        description:
          "Run deterministic OpenWiki preparation before the host agent authors documentation.",
        schema: BeginInput,
        handle: async (input) => this.begin(BeginInput.parse(input)),
      },
      {
        name: "openwiki_finish",
        description:
          "Run deterministic OpenWiki finalization after host authoring and complete the run.",
        schema: RunInput,
        handle: async (input) => this.finish(RunInput.parse(input)),
      },
    ];
  }

  /**
   * Resolves an active run or raises a safe lifecycle error.
   *
   * @param runId - Opaque active run identifier.
   * @returns Matching private session state.
   */
  private requireSession(runId: string): ActiveSession {
    if (!this.active || this.active.id !== runId) {
      throw new HostIntegrationError(
        "invalid_state",
        "No matching OpenWiki run is active.",
      );
    }
    return this.active;
  }
}

/**
 * Projects private session state into the public non-sensitive view.
 *
 * @param session - Active private session state.
 * @returns Safe run view.
 */
function toView(session: ActiveSession): HostRunView {
  return {
    id: session.id,
    root: session.root,
    host: session.host,
    mode: session.mode,
    language: session.language,
    startedAt: session.startedAt,
  };
}
