/**
 * Stable error codes exposed by the host-integration boundary.
 */
export type HostIntegrationErrorCode =
  "conflict" | "invalid_input" | "invalid_state";

/**
 * Expected host-integration failure safe to project through a transport.
 */
export class HostIntegrationError extends Error {
  /**
   * Stable machine-readable failure category.
   */
  readonly code: HostIntegrationErrorCode;

  /**
   * Creates a safe host-integration error.
   *
   * @param code - Stable machine-readable failure category.
   * @param message - Bounded user-facing explanation.
   */
  constructor(code: HostIntegrationErrorCode, message: string) {
    super(message);
    this.name = "HostIntegrationError";
    this.code = code;
  }
}
