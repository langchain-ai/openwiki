import {
  CompositeBackend,
  type AnyBackendProtocol,
  type BackendProtocolV2,
  type EditResult,
  type FileDownloadResponse,
  type FileUploadResponse,
  type GlobResult,
  type GrepResult,
  type LsResult,
  type ReadRawResult,
  type ReadResult,
  type WriteResult,
} from "deepagents";

/**
 * Filesystem-only facade over CompositeBackend.
 *
 * CompositeBackend always exposes execute(), even when its default backend
 * cannot execute commands. DeepAgents consequently registers an execute tool
 * that only fails at runtime. This facade deliberately implements only
 * BackendProtocolV2 filesystem operations, preserving routed filesystems
 * without advertising generic command execution.
 */
export class FilesystemCompositeBackend implements BackendProtocolV2 {
  readonly #backend: CompositeBackend;

  constructor(
    defaultBackend: AnyBackendProtocol,
    routes: Record<string, AnyBackendProtocol>,
  ) {
    this.#backend = new CompositeBackend(defaultBackend, routes);
  }

  ls(path: string): Promise<LsResult> {
    return this.#backend.ls(path);
  }

  read(filePath: string, offset?: number, limit?: number): Promise<ReadResult> {
    return this.#backend.read(filePath, offset, limit);
  }

  readRaw(filePath: string): Promise<ReadRawResult> {
    return this.#backend.readRaw(filePath);
  }

  grep(
    pattern: string,
    path?: string | null,
    glob?: string | null,
  ): Promise<GrepResult> {
    return this.#backend.grep(pattern, path, glob);
  }

  glob(pattern: string, path?: string): Promise<GlobResult> {
    return this.#backend.glob(pattern, path);
  }

  write(filePath: string, content: string): Promise<WriteResult> {
    return this.#backend.write(filePath, content);
  }

  edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): Promise<EditResult> {
    return this.#backend.edit(filePath, oldString, newString, replaceAll);
  }

  uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    return this.#backend.uploadFiles(files);
  }

  downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    return this.#backend.downloadFiles(paths);
  }
}
