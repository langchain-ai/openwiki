/**
 * Base class for every error KEB raises deliberately. Catching this type lets a
 * caller separate KEB's own signalled failures from unexpected runtime errors.
 */
export class KebError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The benchmark JSON is malformed, internally inconsistent, or references data
 * that does not exist (an unknown checkpoint id, a fact version outside the
 * trace, and so on). Raised only while loading and validating; never during a
 * run.
 */
export class BenchmarkValidationError extends KebError {}

/**
 * A destructive filesystem or Git operation was asked to act on a path outside
 * the KEB-created worktree. This is a hard safety stop: it means a containment
 * assumption was violated, so KEB refuses to continue rather than risk touching
 * the developer's checkout or the source repository.
 */
export class WorktreeSafetyError extends KebError {}

/**
 * A Git command failed in a way KEB cannot proceed past (for example the source
 * repository is missing a required commit).
 */
export class GitReplayError extends KebError {}

/**
 * The System Under Test failed to produce a usable wiki at a checkpoint (threw,
 * or left `openwiki/` empty when work was expected).
 */
export class SystemRunError extends KebError {}

/**
 * An evaluator agent returned output that failed schema validation even after a
 * retry, so its verdict cannot be trusted.
 */
export class EvaluationError extends KebError {}
