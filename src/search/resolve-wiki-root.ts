import path from "node:path";
import { openWikiLocalWikiDir } from "../openwiki-home.js";
import type { OpenWikiOutputMode } from "../agent/types.js";

const OPEN_WIKI_DIR = "openwiki";

export type WikiSearchRunMode = "personal" | "code";

export function runModeToOutputMode(
  mode: WikiSearchRunMode,
): OpenWikiOutputMode {
  return mode === "code" ? "repository" : "local-wiki";
}

export function resolveWikiRoot(
  mode: WikiSearchRunMode,
  cwd: string = process.cwd(),
): string {
  if (mode === "personal") {
    return openWikiLocalWikiDir;
  }

  return path.join(cwd, OPEN_WIKI_DIR);
}

export function resolveWikiRootFromOutputMode(
  outputMode: OpenWikiOutputMode,
  cwd: string,
): string {
  if (outputMode === "local-wiki") {
    // Personal-brain agent runs use the wiki directory as cwd.
    return cwd;
  }

  return path.join(cwd, OPEN_WIKI_DIR);
}

export function virtualRootForOutputMode(
  outputMode: OpenWikiOutputMode,
): string {
  return outputMode === "local-wiki" ? "/" : "/openwiki/";
}

export function virtualRootForRunMode(mode: WikiSearchRunMode): string {
  return mode === "personal" ? "/" : "/openwiki/";
}
