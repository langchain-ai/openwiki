import { RepositoryRunError } from "../../generation/errors.js";
import {
  beginRepositoryRun,
  finishRepositoryRun,
  nextRepositoryPage,
  submitRepositoryPage,
  submitRepositoryPlan,
  type ActiveRepositoryRun,
} from "../../generation/repository-run.js";
import { HostIntegrationError } from "./errors.js";
import {
  BeginInput,
  NextPageInput,
  RunInput,
  SubmitPageInput,
  SubmitPlanInput,
  isValidHostId,
  type BeginRequest,
  type NextPageRequest,
  type ProtocolTool,
  type RunRequest,
  type SubmitPageRequest,
  type SubmitPlanRequest,
} from "./protocol.js";
import { resolveRepositoryRoot } from "./repository-root.js";

/**
 * Stable host identity and optional deterministic clock for the MCP adapter.
 */
export interface HostSessionManagerOptions {
  /**
   * Stable lowercase host identity used in protocol metadata.
   */
  host: string;

  /**
   * Provenance actor, defaulting to the host identity when omitted.
   */
  producerActor?: string;

  /**
   * Optional deterministic clock used by production metadata and tests.
   */
  now?: () => Date;
}

/**
 * Thin single-run MCP adapter over the transport-neutral lifecycle core.
 */
export class HostSessionManager {
  /**
   * Current process-local runtime for the active durable run.
   */
  private active: ActiveRepositoryRun | null = null;

  /**
   * Whether one lifecycle operation currently owns this adapter.
   */
  private operationInProgress = false;

  /**
   * Validated host identity recorded in run metadata.
   */
  private readonly host: string;

  /**
   * Validated producer identity recorded in generated provenance.
   */
  private readonly producerActor: string;

  /**
   * Clock forwarded to the repository lifecycle core.
   */
  private readonly now: () => Date;

  /**
   * Stores validated host identity and clock dependencies for one adapter.
   *
   * @param host - Validated host identity.
   * @param producerActor - Validated generated-content producer identity.
   * @param now - Clock used by repository lifecycle operations.
   */
  private constructor(host: string, producerActor: string, now: () => Date) {
    this.host = host;
    this.producerActor = producerActor;
    this.now = now;
  }

  /**
   * Validates host identity and creates an empty single-run adapter.
   *
   * @param options - Host identity, optional producer, and optional clock.
   * @returns A validated rootless session manager.
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
   * Starts or resumes the addressed repository run.
   *
   * @param input - Validated repository and generation mode.
   * @returns Active run context or a proven update no-op.
   */
  async begin(input: BeginRequest): Promise<unknown> {
    return this.runOperation(async () => {
      const root = await resolveRepositoryRoot(input.root);
      const result = await beginRepositoryRun({
        root,
        mode: input.mode,
        language: input.language,
        force: input.force,
        actor: {
          producerActor: this.producerActor,
          metadataModel: getHostAgentIdentity(this.host),
        },
        now: this.now,
      });

      if (!("run" in result)) {
        this.active = null;
        return result.view;
      }

      this.active = result.run;
      return result.view;
    });
  }

  /**
   * Validates and persists the active run's canonical plan.
   *
   * @param input - Run identity and complete proposed plan.
   * @returns The accepted queue size.
   */
  async submitPlan(input: SubmitPlanRequest): Promise<unknown> {
    return this.runOperation(async () => {
      const run = this.requireSession(input.runId);
      return submitRepositoryPlan(run, {
        pages: input.pages,
        deletePages: input.deletePages,
      });
    });
  }

  /**
   * Returns the active run's first pending page job.
   *
   * @param input - Exact active run identity.
   * @returns Current pending page context or queue completion.
   */
  async nextPage(input: NextPageRequest): Promise<unknown> {
    return this.runOperation(async () => {
      const run = this.requireSession(input.runId);
      return nextRepositoryPage(run);
    });
  }

  /**
   * Submits the active job's complete material Claim set.
   *
   * @param input - Active job identity and complete intended Claims.
   * @returns Completed page and remaining queue size.
   */
  async submitPage(input: SubmitPageRequest): Promise<unknown> {
    return this.runOperation(async () => {
      const run = this.requireSession(input.runId);
      return submitRepositoryPage(run, {
        jobId: input.jobId,
        claims: input.claims,
      });
    });
  }

  /**
   * Strictly finalizes the active run and clears process-local state.
   *
   * @param input - Exact active run identity.
   * @returns Successful durable completion result.
   */
  async finish(input: RunRequest): Promise<unknown> {
    return this.runOperation(async () => {
      const run = this.requireSession(input.runId);
      const result = await finishRepositoryRun(run);
      this.active = null;
      return result;
    });
  }

  /**
   * Returns exactly the five OpenWiki 0.4 lifecycle tools.
   *
   * @returns Ordered transport-neutral tool definitions.
   */
  tools(): readonly ProtocolTool[] {
    return [
      {
        name: "openwiki_begin",
        description:
          "Start or resume OpenWiki repository generation. Returns status=noop for a clean update, otherwise the durable planning/generation run state. An unrecognized `language` fails the call with invalid_input instead of starting a run.",
        schema: BeginInput,
        handle: async (input) => this.begin(BeginInput.parse(input)),
      },
      {
        name: "openwiki_submit_plan",
        description:
          "Submit the final canonical page plan. OpenWiki validates it and durably persists the ordered PageJob queue before accepting it.",
        schema: SubmitPlanInput,
        handle: async (input) => this.submitPlan(SubmitPlanInput.parse(input)),
      },
      {
        name: "openwiki_next_page",
        description:
          "Return the first pending page job and its current Claims, or status=complete when no jobs remain.",
        schema: NextPageInput,
        handle: async (input) => this.nextPage(NextPageInput.parse(input)),
      },
      {
        name: "openwiki_submit_page",
        description:
          "Complete the current page job after its Markdown is written by submitting that page's complete intended repository-grounded Claim set. Preserve the id, exact statement, and evidence resource values of each unchanged existing Claim; reuse its id for a necessary revision; omit it to retract it; and omit id for a genuinely new Claim. The final page and Claim set must agree.",
        schema: SubmitPageInput,
        handle: async (input) => this.submitPage(SubmitPageInput.parse(input)),
      },
      {
        name: "openwiki_finish",
        description:
          "Finish only after every PageJob is complete. Runs deterministic deletion, validation, indexing, provenance, Claims finalization, and run metadata persistence.",
        schema: RunInput,
        handle: async (input) => this.finish(RunInput.parse(input)),
      },
    ];
  }

  /**
   * Returns the process-local run only when the durable run ID matches.
   *
   * @param runId - Run identity supplied by the host operation.
   * @returns Matching process-local repository runtime.
   */
  private requireSession(runId: string): ActiveRepositoryRun {
    if (!this.active || this.active.state.runId !== runId) {
      throw new HostIntegrationError(
        "invalid_state",
        "No matching OpenWiki run is active. Call openwiki_begin to start or resume the durable run first.",
      );
    }
    return this.active;
  }

  /**
   * Serializes one adapter operation and maps lifecycle errors at its boundary.
   *
   * @param task - Lifecycle operation that requires exclusive adapter access.
   * @returns The operation result.
   */
  private async runOperation<T>(task: () => Promise<T>): Promise<T> {
    this.startOperation();
    try {
      return await task();
    } catch (error) {
      throw mapRepositoryRunError(error);
    } finally {
      this.operationInProgress = false;
    }
  }

  /**
   * Acquires the adapter's single-operation guard or rejects concurrent work.
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
 * Converts lifecycle-domain errors into stable host integration errors.
 *
 * @param error - Unknown error leaving the repository lifecycle core.
 * @returns The mapped integration error or the original unknown error.
 */
function mapRepositoryRunError(error: unknown): unknown {
  if (!(error instanceof RepositoryRunError)) return error;

  switch (error.code) {
    case "conflict":
      return new HostIntegrationError("conflict", error.message);
    case "invalid_input":
    case "not_found":
      return new HostIntegrationError("invalid_input", error.message);
    case "invalid_state":
      return new HostIntegrationError("invalid_state", error.message);
  }
}

/**
 * Derives the metadata model identity for one validated host.
 *
 * @param host - Validated host identity.
 * @returns Stable metadata model identity.
 */
function getHostAgentIdentity(host: string): string {
  return `host-agent/${host}`;
}
