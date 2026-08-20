export type OpenWikiCommand = "chat" | "init" | "update";
export type OpenWikiOutputMode = "local-wiki" | "repository";

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
  language?: string | null;
  modelId?: string | null;
  onEvent?: (event: OpenWikiRunEvent) => void;
  /** Observable temporary plan content, captured before OpenWiki deletes it. */
  onPlanSnapshot?: (plan: string) => void | Promise<void>;
  /**
   * Lossless LangGraph stream seam for telemetry such as tool outputs/errors.
   * Consumers must redact and bound data before persistence.
   */
  onRawStreamChunk?: (chunk: unknown) => void | Promise<void>;
  outputMode?: OpenWikiOutputMode;
  /**
   * Read-only recall into externally stored reasoning memory, exposed to the
   * agent as the recall_reasoning_memory tool. Supplied by the host
   * integration; when absent the tool is not added and behavior is unchanged.
   */
  recallReasoningMemory?: (query: string) => Promise<string>;
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
