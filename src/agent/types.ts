export type OpenWikiCommand = "chat" | "init" | "update";
export type OpenWikiOutputMode = "local-wiki" | "repository";

/**
 * The role a run plays inside a recursive monorepo documentation pass. Absent
 * for ordinary single-repo runs. `subproject` runs are rooted at a subproject
 * and document only that subtree; the `root` run documents the monorepo root and
 * links down to the per-subproject sub-wikis instead of deep-documenting them.
 */
export type RecursionRole = "subproject" | "root";

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
    }
  | {
      type: "tool_end";
      id: string;
      name: string;
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
  recursionRole?: RecursionRole;
  threadId?: string;
  userMessage?: string | null;
  telemetryFile?: string;
  /**
   * When set, overrides the wiki brief that would otherwise be read from the
   * run root's openwiki/INSTRUCTIONS.md. Used by the recursive orchestrator to
   * inject a manifest-supplied per-subproject or root goal (manifest goal takes
   * precedence over a subproject's INSTRUCTIONS.md).
   */
  wikiGoalOverride?: string;
  /**
   * When set, skips the per-run code-mode repo setup (workflow + agent-file
   * snippets). The recursive orchestrator sets this so its per-subproject and
   * root sub-runs do not each re-scaffold repo setup — it owns that once at the
   * repository root.
   */
  skipRepoSetup?: boolean;
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
