import { randomUUID } from "node:crypto";
import { OpenWikiLocalShellBackend } from "../../agent/docs-only-backend.js";
import { OpenWikiIgnore } from "../../agent/openwiki-ignore.js";
import type { RunContext } from "../../agent/types.js";
import {
  beginRepositoryWikiReplacement,
  type RepositoryWikiReplacement,
} from "../../agent/wiki-replacement.js";
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
import {
  ClaimSessionError,
  EvidenceResourceError,
} from "../../claims/core/errors.js";
import {
  inspectClaims as inspectClaimsOperation,
  INSPECT_CLAIMS_DESCRIPTION,
  resolveClaims as resolveClaimsOperation,
  RESOLVE_CLAIMS_DESCRIPTION,
} from "../../claims/brains/code/tools.js";
import {
  prepareClaimsRuntime,
  type ClaimsRuntime,
} from "../../claims/brains/code/runtime.js";
import { ClaimsStore } from "../../claims/brains/code/store.js";
import { HostIntegrationError } from "./errors.js";
import {
  BeginInput,
  InspectClaimsInput,
  ResolveClaimsInput,
  RunInput,
  isValidHostId,
  type BeginRequest,
  type HostRunMode,
  type InspectClaimsRequest,
  type ProtocolTool,
  type ResolveClaimsRequest,
  type RunRequest,
} from "./protocol.js";
import { resolveRepositoryRoot } from "./repository-root.js";

/**
 * Construction options for one host lifecycle manager.
 */
export interface HostSessionManagerOptions {
  /**
   * Stable lowercase host identifier used in run metadata.
   */
  host: string;

  /**
   * Stable OKF producer actor for host-authored page bodies.
   *
   * @default host
   */
  producerActor?: string;

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

  /**
   * Number of stale or unresolved Claims detected before host authoring.
   */
  claimsIssueCount: number;
}

/**
 * Successful terminal result of a host-authored wiki run.
 */
export interface FinishResult {
  /**
   * Durable lifecycle outcome.
   */
  status: "complete";

  /**
   * Non-fatal page-local Claims persistence warnings.
   *
   * @default undefined - Claims finalization completed without warnings.
   */
  warnings?: string[];
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

  /**
   * Run-scoped Claims state shared by inspection, mutation, and finalization.
   */
  claimsRuntime: ClaimsRuntime;

  /**
   * Non-fatal Claims warnings accumulated during finalization.
   */
  claimsWarnings: string[];

  /**
   * Recoverable replacement retained until a successful init finish.
   *
   * @default undefined for update runs.
   */
  wikiReplacement?: RepositoryWikiReplacement;
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
   * Whether a mutating lifecycle operation currently owns the manager.
   */
  private operationInProgress = false;

  /**
   * Stable host identifier written to run metadata.
   */
  private readonly host: string;

  /**
   * Stable producer stamped on host-authored page bodies.
   */
  private readonly producerActor: string;

  /**
   * Clock used to create deterministic run timestamps.
   */
  private readonly now: () => Date;

  /**
   * Creates a rootless manager after host configuration validation.
   *
   * @param host - Stable host identifier.
   * @param producerActor - Stable generated-provenance producer.
   * @param now - Run timestamp source.
   */
  private constructor(host: string, producerActor: string, now: () => Date) {
    this.host = host;
    this.producerActor = producerActor;
    this.now = now;
  }

  /**
   * Validates configuration and creates a rootless host manager.
   *
   * @param options - Host ID and optional clock.
   * @returns Validated lifecycle manager.
   */
  static create(options: HostSessionManagerOptions): HostSessionManager {
    if (!isValidHostId(options.host)) {
      throw new HostIntegrationError(
        "invalid_input",
        "The host ID must contain lowercase letters, digits, or hyphens.",
      );
    }
    const producerActor = options.producerActor ?? options.host;
    if (!isValidHostId(producerActor)) {
      throw new HostIntegrationError(
        "invalid_input",
        "The producer actor must contain lowercase letters, digits, or hyphens.",
      );
    }

    return new HostSessionManager(
      options.host,
      producerActor,
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
    this.startOperation();
    const supersededSession = this.active;
    this.active = null;
    let wikiReplacement: RepositoryWikiReplacement | undefined;

    try {
      const runId = randomUUID();
      const runTimestamp = this.now().toISOString();
      const root = await resolveRepositoryRoot(input.root);
      await ensureCodeModeRepoSetup(root, {
        createWorkflow: input.mode === "init",
      });
      const ignore = await OpenWikiIgnore.load(root);
      if (input.mode === "init") {
        wikiReplacement = await beginRepositoryWikiReplacement(root);
      }
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
      const claimsWarnings: string[] = [];
      const claimsRuntime = await prepareClaimsRuntime(
        input.mode,
        "repository",
        root,
        ignore,
        (warning) => claimsWarnings.push(warning),
      );
      if (!claimsRuntime) {
        throw new Error("Repository Claims runtime was not prepared.");
      }

      await writeLastUpdateMetadata(
        input.mode,
        root,
        getHostAgentIdentity(this.host),
        "repository",
        "interrupted",
        language,
      );
      const preparedWiki = await prepareWikiForAuthoring({
        backend,
        outputMode: "repository",
        conceptType: resolveConceptTypeLabel(language),
      });

      const nextSession: ActiveSession = {
        id: runId,
        root,
        host: this.host,
        mode: input.mode,
        language,
        startedAt: runTimestamp,
        backend,
        beforeContentSnapshot,
        preparedWiki,
        claimsRuntime,
        claimsWarnings,
        wikiReplacement,
      };

      // A later begin deliberately supersedes an interrupted host run. Preserve
      // the authored state from that run, matching the existing recovery
      // behavior, while releasing any init backup it still owns.
      await supersededSession?.wikiReplacement?.commit();
      this.active = nextSession;

      return {
        runId,
        root,
        mode: input.mode,
        language,
        lastUpdate: context.lastUpdate,
        wikiGoal: context.wikiGoal,
        updatePreflight,
        ignoredPatterns: ignore.patterns.length,
        claimsIssueCount: claimsRuntime.issueCount,
      };
    } catch (error) {
      this.active = supersededSession;
      if (wikiReplacement) {
        try {
          await wikiReplacement.rollback();
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Coding-agent wiki init failed and the previous wiki could not be fully restored.",
            { cause: rollbackError },
          );
        }
      }
      throw error;
    } finally {
      this.operationInProgress = false;
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
    this.startOperation();
    try {
      const session = this.requireSession(input.runId);

      await removeTemporaryWorkingFiles(session.root, "repository");
      await finalizeWikiArtifacts({
        backend: session.backend,
        outputMode: "repository",
        labels: resolveIndexLabels(session.language),
        conceptType: resolveConceptTypeLabel(session.language),
        prepared: session.preparedWiki,
        at: session.startedAt,
        producerActor: this.producerActor,
        claimSources:
          session.claimsRuntime.session.getEvidenceResourcesByPage(),
      });
      await reconcileDeletedClaimPages(session);
      await session.claimsRuntime.finalize(session.startedAt);
      await persistRunMetadataIfChanged(
        session.mode,
        session.root,
        getHostAgentIdentity(session.host),
        "repository",
        session.beforeContentSnapshot,
        "complete",
        session.language,
      );
      await session.wikiReplacement?.commit();

      this.active = null;
      return session.claimsWarnings.length > 0
        ? { status: "complete", warnings: [...session.claimsWarnings] }
        : { status: "complete" };
    } finally {
      this.operationInProgress = false;
    }
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
   * Inspects selected Claims without creating a write obligation.
   *
   * @param input - Active run selector and exact Claims selector.
   * @returns Selected Claims grouped by their owning wiki page.
   */
  async inspectClaims(input: InspectClaimsRequest): Promise<unknown> {
    this.startOperation();
    try {
      const session = this.requireSession(input.runId);
      return await inspectClaimsOperation(session.claimsRuntime.session, {
        ids: input.ids,
        pages: input.pages,
      });
    } catch (error) {
      throw mapClaimsError(error);
    } finally {
      this.operationInProgress = false;
    }
  }

  /**
   * Applies one cross-page Claims mutation batch to the active run.
   *
   * @param input - Active run selector and page-local Claims operations.
   * @returns Applied mutation identifiers grouped by wiki page.
   */
  async resolveClaims(input: ResolveClaimsRequest): Promise<unknown> {
    this.startOperation();
    try {
      const session = this.requireSession(input.runId);
      return await resolveClaimsOperation(session.claimsRuntime.session, {
        pages: input.pages,
      });
    } catch (error) {
      throw mapClaimsError(error);
    } finally {
      this.operationInProgress = false;
    }
  }

  /**
   * Returns the complete transport-neutral host authoring tool set.
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
        name: "openwiki_inspect_claims",
        description: INSPECT_CLAIMS_DESCRIPTION,
        schema: InspectClaimsInput,
        handle: async (input) =>
          this.inspectClaims(InspectClaimsInput.parse(input)),
      },
      {
        name: "openwiki_resolve_claims",
        description: RESOLVE_CLAIMS_DESCRIPTION,
        schema: ResolveClaimsInput,
        handle: async (input) =>
          this.resolveClaims(ResolveClaimsInput.parse(input)),
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

  /**
   * Claims the manager for one mutating lifecycle operation.
   */
  private startOperation(): void {
    if (this.operationInProgress) {
      throw new HostIntegrationError(
        "invalid_state",
        "Another OpenWiki lifecycle operation is already in progress.",
      );
    }
    this.operationInProgress = true;
  }
}

/**
 * Records sidecars whose Markdown pages were deleted with native host tools.
 *
 * @param session - Active host run with repository and Claims state.
 */
async function reconcileDeletedClaimPages(
  session: ActiveSession,
): Promise<void> {
  const store = new ClaimsStore(session.root);
  const currentPages = new Set(await store.discoverPages());
  for (const page of await store.discoverSidecarPages()) {
    if (!currentPages.has(page)) {
      await session.claimsRuntime.session.recordDeletion(page);
    }
  }
}

/**
 * Converts model-correctable Claims failures into bounded MCP domain errors.
 *
 * @param error - Claims or unexpected operation failure.
 * @returns Safe host error for correctable input, or the original failure.
 */
function mapClaimsError(error: unknown): unknown {
  return error instanceof ClaimSessionError ||
    error instanceof EvidenceResourceError
    ? new HostIntegrationError("invalid_input", error.message)
    : error;
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

/**
 * Formats the stable actor shared by host-authored provenance and run metadata.
 *
 * @param host - Validated lowercase host identifier.
 * @returns Stable host-agent actor.
 */
function getHostAgentIdentity(host: string): string {
  return `host-agent/${host}`;
}
