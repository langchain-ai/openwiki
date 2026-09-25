/**
 * Stable machine-readable failures exposed by the repository-run core.
 */
export type RepositoryRunErrorCode =
  "invalid_input" | "invalid_state" | "conflict" | "not_found";

/**
 * Reports an invalid or conflicting repository-run lifecycle operation.
 */
export class RepositoryRunError extends Error {
  /**
   * Stable protocol-facing category for this lifecycle failure.
   */
  readonly code: RepositoryRunErrorCode;

  /**
   * Creates a lifecycle error with a stable protocol-facing error code.
   */
  constructor(code: RepositoryRunErrorCode, message: string) {
    super(message);
    this.name = "RepositoryRunError";
    this.code = code;
  }
}
