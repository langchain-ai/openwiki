/**
 * Base error for deterministic Grounded Claims failures.
 */
export class ClaimsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimsError";
  }
}

/**
 * Reports invalid or unsafe claim persistence state.
 */
export class ClaimsPersistenceError extends ClaimsError {
  constructor(message: string) {
    super(message);
    this.name = "ClaimsPersistenceError";
  }
}

/**
 * Reports a generated Markdown page that disappeared before synchronization.
 */
export class ClaimsPageMissingError extends ClaimsPersistenceError {
  constructor(message: string) {
    super(message);
    this.name = "ClaimsPageMissingError";
  }
}

/**
 * Reports a persistence boundary that cannot be proven safe.
 *
 * Unlike ordinary page-local persistence failures, callers must not degrade
 * past this error because doing so could cross a repository boundary.
 */
export class ClaimsPersistenceSecurityError extends ClaimsPersistenceError {
  constructor(message: string) {
    super(message);
    this.name = "ClaimsPersistenceSecurityError";
  }
}

/**
 * Reports a malformed or unsafe evidence resource.
 */
export class EvidenceResourceError extends ClaimsError {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceResourceError";
  }
}

/**
 * Reports an operational failure while resolving otherwise valid evidence.
 */
export class EvidenceResolutionError extends ClaimsError {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceResolutionError";
  }
}

/**
 * Reports an evidence path whose physical containment cannot be proven safe.
 */
export class EvidenceSecurityError extends EvidenceResolutionError {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceSecurityError";
  }
}

/**
 * Reports an invalid claim mutation or authoring-order violation.
 */
export class ClaimSessionError extends ClaimsError {
  constructor(message: string) {
    super(message);
    this.name = "ClaimSessionError";
  }
}
