/**
 * Filesystem operation represented in the live activity tree.
 */
export type RunActivityOperation = "read" | "search" | "write";

/**
 * Side of the run to which an activity path belongs.
 */
export type RunActivityScope = "openwiki" | "repository";

/**
 * Lifecycle state used to color and group an activity path.
 */
export type RunActivityStatus = "active" | "error" | "recent";

/**
 * Fields shared by every retained run-log item.
 */
interface RunLogItemBase {
  /**
   * The line's identity, stable across in-place updates.
   */
  id: number;
}

/**
 * Current native repository-generation lifecycle retained by the run view.
 */
export interface RunRepositoryProgressLogItem extends RunLogItemBase {
  /**
   * Discriminator for structured repository lifecycle progress.
   */
  type: "repository_progress";

  /**
   * Current native repository-generation lifecycle stage.
   */
  stage: "planning" | "generating" | "finalizing" | "replanning" | "noop";

  /**
   * Whether this stage continues an interrupted durable run.
   *
   * @default false
   */
  resumed?: boolean;

  /**
   * Canonical page currently owned by the active worker.
   *
   * @default undefined outside generation
   */
  page?: string;

  /**
   * One-based page position in the persisted ordered queue.
   *
   * @default undefined outside generation
   */
  pageIndex?: number;

  /**
   * Total page count in the persisted ordered queue.
   *
   * @default undefined until planning completes
   */
  pageCount?: number;
}

/**
 * One exact filesystem path shown in the live activity view.
 */
export interface RunActivityLogItem extends RunLogItemBase {
  /**
   * Discriminator for an exact filesystem activity entry.
   */
  type: "activity";

  /**
   * Tool-call ids that are still operating on this path.
   *
   * @default undefined - no tool calls are currently active on the path.
   */
  activeToolCallIds?: string[];

  /**
   * Kind of filesystem operation performed on the path.
   */
  activityOperation: RunActivityOperation;

  /**
   * Normalized repository-relative path or search scope.
   */
  activityPath: string;

  /**
   * Whether the path belongs to source material or generated OpenWiki data.
   */
  activityScope: RunActivityScope;

  /**
   * Current display lifecycle for the path.
   */
  activityStatus: RunActivityStatus;
}

/**
 * One opt-in diagnostic line retained with the run.
 */
export interface RunDebugLogItem extends RunLogItemBase {
  /**
   * Discriminator for an opt-in diagnostic entry.
   */
  type: "debug";

  /**
   * Sanitized diagnostic text safe to display in the terminal.
   */
  content: string;
}

/**
 * The main agent's final text response.
 */
interface RunTextLogItem extends RunLogItemBase {
  /**
   * Discriminator for the main agent's final text.
   */
  type: "text";

  /**
   * Accumulated main-agent response text.
   */
  content: string;
}

/**
 * Aggregate tool activity and outcome data for one run.
 */
export interface RunToolLogItem extends RunLogItemBase {
  /**
   * Discriminator for the aggregate tool summary.
   */
  type: "tool";

  /**
   * Preformatted live activity counts.
   */
  content: string;

  /**
   * How many tool actions started during the run.
   *
   * @default undefined - treated as a single action.
   */
  actionCount?: number;

  /**
   * The ids of tool calls that are still running.
   *
   * @default undefined - the summary has no active calls.
   */
  activeToolCallIds?: string[];

  /**
   * How many actions failed.
   *
   * @default undefined - treated as zero failures.
   */
  errorCount?: number;

  /**
   * Unique repository files successfully read during this run. The live view
   * uses these paths to build a cumulative exploration map without treating
   * search matches as explored files.
   *
   * @default undefined - no repository files have completed reading.
   */
  exploredPaths?: string[];

  /**
   * How many explicit file-read tools started.
   *
   * @default undefined - treated as zero reads.
   */
  readCount?: number;

  /**
   * How many explicit repository-search tools started.
   *
   * @default undefined - treated as zero searches.
   */
  searchCount?: number;

  /**
   * How many agent tasks started.
   *
   * @default undefined - treated as zero tasks.
   */
  taskCount?: number;

  /**
   * How many explicit file-write tools started.
   *
   * @default undefined - treated as zero writes.
   */
  writeCount?: number;

  /**
   * Unique persistent OpenWiki pages successfully written. Repeated writes to
   * the same page are recorded once.
   *
   * @default undefined - no successful OpenWiki writes completed.
   */
  writtenPaths?: string[];

  /**
   * The aggregate tool lifecycle state.
   */
  status: "done" | "error" | "running";
}

/**
 * One bounded entry in a run's progress and final-result model.
 */
export type RunLogItem =
  | RunActivityLogItem
  | RunDebugLogItem
  | RunRepositoryProgressLogItem
  | RunTextLogItem
  | RunToolLogItem;
