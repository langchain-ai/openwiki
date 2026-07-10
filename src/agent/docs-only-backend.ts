import {
  LocalShellBackend,
  type EditResult,
  type LocalShellBackendOptions,
  type WriteResult,
} from "deepagents";
import { OPEN_WIKI_DIR } from "../constants.js";
import type { OpenWikiOutputMode } from "./types.js";

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

    return super.write(filePath, content);
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

    return super.edit(filePath, oldString, newString, replaceAll);
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

export function isOpenWikiDocsPath(filePath: string): boolean {
  const normalizedPath = filePath.trim().replace(/\\/gu, "/");
  const virtualPath = normalizedPath.replace(/^\/+/u, "");

  return (
    virtualPath === OPEN_WIKI_DIR || virtualPath.startsWith(`${OPEN_WIKI_DIR}/`)
  );
}
