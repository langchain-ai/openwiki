import path from "node:path";
import {
  LocalShellBackend,
  type EditResult,
  type LocalShellBackendOptions,
  type WriteResult,
} from "deepagents";
import { OPEN_WIKI_DIR } from "../constants.js";
import type { OpenWikiOutputMode } from "./types.js";

export const MUTATION_PATH_METADATA_KEY = "openwikiMutationPath";

type OpenWikiBackendOptions = LocalShellBackendOptions & {
  docsOnly?: boolean;
  outputMode?: OpenWikiOutputMode;
};

export class OpenWikiLocalShellBackend extends LocalShellBackend {
  private readonly docsOnly: boolean;
  private readonly outputMode: OpenWikiOutputMode;

  constructor(options: OpenWikiBackendOptions) {
    super(options);
    this.docsOnly = options.docsOnly === true;
    this.outputMode = options.outputMode ?? "repository";
  }

  override async write(
    filePath: string,
    content: string,
  ): Promise<WriteResult> {
    const error = this.getDocsOnlyWriteError(filePath);
    if (error) {
      return { error };
    }

    return markMutation(await super.write(filePath, content), filePath);
  }

  override async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): Promise<EditResult> {
    const error = this.getDocsOnlyWriteError(filePath);
    if (error) {
      return { error };
    }

    return markMutation(
      await super.edit(filePath, oldString, newString, replaceAll),
      filePath,
    );
  }

  private getDocsOnlyWriteError(filePath: string): string | null {
    if (
      !this.docsOnly ||
      this.outputMode === "local-wiki" ||
      isOpenWikiDocsPath(filePath)
    ) {
      return null;
    }

    return `OpenWiki repository init/update runs may only write under /${OPEN_WIKI_DIR}/. Refused path: ${filePath}`;
  }
}

/** Carries a successful mutation's file path into the ToolMessage metadata used by the validator. */
function markMutation<Result extends WriteResult | EditResult>(
  result: Result,
  filePath: string,
): Result {
  if (!result.error) {
    result.metadata = {
      ...result.metadata,
      [MUTATION_PATH_METADATA_KEY]: result.path ?? filePath,
    };
  }
  return result;
}

export function isOpenWikiDocsPath(filePath: string): boolean {
  const slashed = filePath.trim().replace(/\\/gu, "/");
  // Collapse `..`/`.` segments before the prefix check so a path like
  // "/openwiki/../AGENTS.md" cannot escape the openwiki/ confinement.
  const normalized = path.posix.normalize(`/${slashed.replace(/^\/+/u, "")}`);
  const virtualPath = normalized.replace(/^\/+/u, "");

  return (
    virtualPath === OPEN_WIKI_DIR || virtualPath.startsWith(`${OPEN_WIKI_DIR}/`)
  );
}
