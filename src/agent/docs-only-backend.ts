import {
  LocalShellBackend,
  type EditResult,
  type ExecuteResponse,
  type FileDownloadResponse,
  type FileInfo,
  type FileUploadResponse,
  type GlobResult,
  type GrepMatch,
  type GrepResult,
  type LocalShellBackendOptions,
  type LsResult,
  type ReadRawResult,
  type ReadResult,
  type WriteResult,
} from "deepagents";
import { OPEN_WIKI_DIR } from "../constants.js";
import {
  OPENWIKI_IGNORE_FILE,
  OpenWikiIgnoreRules,
} from "./openwiki-ignore.js";
import type { OpenWikiOutputMode } from "./types.js";

export const MUTATION_PATH_METADATA_KEY = "openwikiMutationPath";

type OpenWikiBackendOptions = LocalShellBackendOptions & {
  docsOnly?: boolean;
  ignoreRules?: OpenWikiIgnoreRules;
  outputMode?: OpenWikiOutputMode;
};

const allowedIgnoredShellCommands = [
  /^pwd$/u,
  /^git\s+(?:--no-pager\s+)?rev-parse\s+HEAD$/u,
  /^rm\s+-f\s+(?:\.\/)?openwiki\/_plan\.md$/u,
];

export class OpenWikiLocalShellBackend extends LocalShellBackend {
  private readonly docsOnly: boolean;
  private readonly ignoreRules: OpenWikiIgnoreRules;
  private readonly outputMode: OpenWikiOutputMode;

  constructor(options: OpenWikiBackendOptions) {
    super(options);
    this.docsOnly = options.docsOnly === true;
    this.ignoreRules = options.ignoreRules ?? new OpenWikiIgnoreRules([]);
    this.outputMode = options.outputMode ?? "repository";
  }

  override async read(
    filePath: string,
    offset?: number,
    limit?: number,
  ): Promise<ReadResult> {
    const error = this.getIgnoredPathError(filePath);

    if (error) {
      return { error };
    }

    return super.read(filePath, offset, limit);
  }

  override async readRaw(filePath: string): Promise<ReadRawResult> {
    const error = this.getIgnoredPathError(filePath);

    if (error) {
      return { error };
    }

    return super.readRaw(filePath);
  }

  override async write(
    filePath: string,
    content: string,
  ): Promise<WriteResult> {
    const error =
      this.getIgnoredPathError(filePath) ??
      this.getDocsOnlyWriteError(filePath);

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
    const error =
      this.getIgnoredPathError(filePath) ??
      this.getDocsOnlyWriteError(filePath);

    if (error) {
      return { error };
    }

    return markMutation(
      await super.edit(filePath, oldString, newString, replaceAll),
      filePath,
    );
  }

  override async ls(dirPath: string): Promise<LsResult> {
    const error = this.getIgnoredPathError(dirPath, true);

    if (error) {
      return { error };
    }

    const result = await super.ls(dirPath);

    return {
      ...result,
      files: result.files?.filter((file) => !this.isIgnoredFile(file)),
    };
  }

  override async grep(
    pattern: string,
    dirPath?: string | null,
    glob?: string | null,
  ): Promise<GrepResult> {
    if (dirPath && this.ignoreRules.ignores(dirPath, true)) {
      return { matches: [] };
    }

    const result = await super.grep(pattern, dirPath ?? undefined, glob);

    return {
      ...result,
      matches: result.matches?.filter((match) => !this.isIgnoredMatch(match)),
    };
  }

  override async glob(
    pattern: string,
    searchPath?: string,
  ): Promise<GlobResult> {
    if (searchPath && this.ignoreRules.ignores(searchPath, true)) {
      return { files: [] };
    }

    const result = await super.glob(pattern, searchPath);

    return {
      ...result,
      files: result.files?.filter((file) => !this.isIgnoredFile(file)),
    };
  }

  override async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    const allowedFiles = files.filter(
      ([filePath]) => !this.ignoreRules.ignores(filePath),
    );

    if (allowedFiles.length === files.length) {
      return super.uploadFiles(files);
    }

    const allowedResults = await super.uploadFiles(allowedFiles);
    const resultsByPath = new Map(
      allowedResults.map((result) => [result.path, result]),
    );

    return files.map(([filePath]) => {
      if (this.ignoreRules.ignores(filePath)) {
        return { error: "permission_denied", path: filePath };
      }

      return (
        resultsByPath.get(filePath) ?? { error: "invalid_path", path: filePath }
      );
    });
  }

  override async downloadFiles(
    paths: string[],
  ): Promise<FileDownloadResponse[]> {
    const allowedPaths = paths.filter(
      (filePath) => !this.ignoreRules.ignores(filePath),
    );

    if (allowedPaths.length === paths.length) {
      return super.downloadFiles(paths);
    }

    const allowedResults = await super.downloadFiles(allowedPaths);
    const resultsByPath = new Map(
      allowedResults.map((result) => [result.path, result]),
    );

    return paths.map((filePath) => {
      if (this.ignoreRules.ignores(filePath)) {
        return { content: null, error: "permission_denied", path: filePath };
      }

      return (
        resultsByPath.get(filePath) ?? {
          content: null,
          error: "invalid_path",
          path: filePath,
        }
      );
    });
  }

  override async execute(command: string): Promise<ExecuteResponse> {
    if (
      this.ignoreRules.isActive &&
      !isAllowedShellCommandWithIgnore(command)
    ) {
      return {
        exitCode: 1,
        output: `Shell execute is restricted while ${OPENWIKI_IGNORE_FILE} is active. Use filesystem tools so ignored paths stay excluded.`,
        truncated: false,
      };
    }

    return super.execute(command);
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

  private getIgnoredPathError(
    filePath: string,
    isDirectory = false,
  ): string | null {
    if (!this.ignoreRules.ignores(filePath, isDirectory)) {
      return null;
    }

    return `Path is excluded by ${OPENWIKI_IGNORE_FILE}: ${filePath}`;
  }

  private isIgnoredFile(file: FileInfo): boolean {
    return this.ignoreRules.ignores(file.path, file.is_dir === true);
  }

  private isIgnoredMatch(match: GrepMatch): boolean {
    return this.ignoreRules.ignores(match.path);
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
  const normalizedPath = filePath.trim().replace(/\\/gu, "/");
  const virtualPath = normalizedPath.replace(/^\/+/u, "");

  return (
    virtualPath === OPEN_WIKI_DIR || virtualPath.startsWith(`${OPEN_WIKI_DIR}/`)
  );
}

function isAllowedShellCommandWithIgnore(command: string): boolean {
  const trimmedCommand = command.trim();

  return allowedIgnoredShellCommands.some((allowedCommand) =>
    allowedCommand.test(trimmedCommand),
  );
}
