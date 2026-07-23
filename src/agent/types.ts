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

export type OpenWikiRunEvent =
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
};

export type UpdateMetadata = {
  updatedAt: string;
  command: OpenWikiCommand;
  gitHead?: string;
  model: string;
};

export type RunContext = {
  lastUpdate: UpdateMetadata | null;
  gitSummary: string;
  wikiGoal?: string;
};
