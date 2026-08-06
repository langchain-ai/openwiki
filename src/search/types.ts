export type WikiSearchHit = {
  /** Wiki-relative POSIX path, e.g. topics/deepagents-harness.md */
  path: string;
  /** Virtual filesystem path for OpenWiki agent tools, e.g. /topics/... */
  virtualPath: string;
  line: number;
  snippet: string;
  score: number;
};

export type WikiSearchOptions = {
  rootDir: string;
  query: string;
  /** Prefix for agent-facing virtual paths. "/" for personal, "/openwiki/" for code. */
  virtualRoot?: string;
  maxResults?: number;
  maxFileBytes?: number;
};
