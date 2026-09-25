export type OpenWikiCommand = "chat" | "init" | "update";
export type OpenWikiOutputMode = "local-wiki" | "repository";

export type OpenWikiRunResult = {
  command: OpenWikiCommand;
  model: string;
  skipped?: boolean;
};

/**
 * Structured repository-generation lifecycle progress for CLI consumers.
 */
export interface RepositoryGenerationProgressEvent {
  /**
   * Event discriminator for repository lifecycle progress.
   */
  type: "repository_progress";

  /**
   * Current native repository-generation lifecycle stage.
   */
  stage: "planning" | "generating" | "finalizing" | "replanning" | "noop";

  /**
   * Whether this stage is continuing a previously interrupted durable run.
   *
   * @default false
   */
  resumed?: boolean;

  /**
   * Canonical page currently owned by the active page worker.
   *
   * @default undefined outside page generation
   */
  page?: string;

  /**
   * One-based position of the active page in the persisted ordered queue.
   *
   * @default undefined outside page generation
   */
  pageIndex?: number;

  /**
   * Total number of pages in the persisted ordered queue.
   *
   * @default undefined until a plan is durable
   */
  pageCount?: number;

  /**
   * Number of page jobs already complete or skipped in this run.
   *
   * @default undefined outside page generation
   */
  completedCount?: number;

  /**
   * Canonical pages currently owned by in-flight workers, in start order.
   *
   * A single sequential worker reports at most one entry; consumers fall back
   * to `page` and `pageIndex` in that case.
   *
   * @default undefined outside page generation
   */
  inFlightPages?: string[];
}

export type OpenWikiRunEvent =
  | RepositoryGenerationProgressEvent
  | {
      source?: "main" | "subgraph";
      type: "text";
      text: string;
    }
  | {
      type: "tool_start";
      call: string;
      id: string;
      input: unknown;
      name: string;
      /**
       * Canonical page owned by the worker that issued the call.
       *
       * @default undefined for the planner and non-repository runs
       */
      page?: string;
    }
  | {
      type: "tool_end";
      id: string;
      name: string;
      /**
       * Canonical page owned by the worker that issued the call.
       *
       * @default undefined for the planner and non-repository runs
       */
      page?: string;
      status: "error" | "finished";
    }
  | {
      type: "debug";
      message: string;
    };

export type OpenWikiRunOptions = {
  debug?: boolean;
  isFollowup?: boolean;
  language?: string | null;
  modelId?: string | null;
  onEvent?: (event: OpenWikiRunEvent) => void;
  outputMode?: OpenWikiOutputMode;
  threadId?: string;
  userMessage?: string | null;
  telemetryFile?: string;
};

export type UpdateRunStatus = "complete" | "interrupted";

export type UpdateMetadata = {
  updatedAt: string;
  command: OpenWikiCommand;
  gitHead?: string;
  model: string;
  status?: UpdateRunStatus;
  language?: string;
};

export type RunContext = {
  lastUpdate: UpdateMetadata | null;
  language?: string;
  wikiGoal?: string;
};
