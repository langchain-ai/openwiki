import { EvaluationError } from "../core/errors.js";
import type { ArtifactSection } from "./documents.js";
import type { EvaluationExcerpt } from "./prompts.js";

/**
 * Split an ordered array into stable non-empty batches.
 *
 * @param values - Ordered values to batch.
 * @param size - Positive maximum batch size.
 *
 * @returns Stable batches preserving input order.
 */
export function batch<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];

  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }

  return result;
}

/**
 * Validate a positive integer pass option.
 *
 * @param value - Configured numeric value.
 * @param name - Option name used in diagnostics.
 *
 * @throws EvaluationError when the value is not a positive integer.
 */
export function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new EvaluationError(`${name} must be a positive integer.`);
  }
}

/**
 * Runs one asynchronous task, deferring its start until the shared concurrency
 * budget has a free slot. A single limiter passed to several passes bounds their
 * combined in-flight work, not each pass independently.
 */
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Default in-flight model-call budget for a pass when no shared limiter is
 * supplied. Passes invoked standalone (mainly tests) fall back to this; the
 * runner passes one shared limiter so the three passes share a single budget.
 */
export const DEFAULT_PASS_CONCURRENCY = 6;

/**
 * Build an in-memory concurrency limiter that admits at most `maxConcurrent`
 * tasks at once and releases a slot when a task settles. Admission is
 * first-in-first-out, so a limiter shared across passes stays fair and the order
 * tasks are enqueued in is the order they start.
 *
 * @param maxConcurrent - Maximum simultaneously running tasks.
 *
 * @returns A limiter that wraps each task in the shared budget.
 *
 * @throws EvaluationError when `maxConcurrent` is not a positive integer.
 */
export function createLimiter(maxConcurrent: number): Limiter {
  assertPositiveInteger(maxConcurrent, "Limiter maxConcurrent");
  let active = 0;
  const waiting: Array<() => void> = [];

  const release = (): void => {
    active -= 1;
    const start = waiting.shift();

    if (start !== undefined) {
      start();
    }
  };

  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = (): void => {
        active += 1;
        task().then(
          (value) => {
            release();
            resolve(value);
          },
          (error: unknown) => {
            release();
            reject(error as Error);
          },
        );
      };

      if (active < maxConcurrent) {
        run();
      } else {
        waiting.push(run);
      }
    });
}

/**
 * Map every item through an asynchronous mapper under a shared concurrency
 * limiter, preserving input order in the result. This is the concurrent
 * replacement for a serial `for (const item of items) await mapper(item)` drain:
 * the mapper still sees each item exactly once, but up to the limiter's budget
 * run at a time, so the wall-clock cost becomes the depth of the queue divided by
 * the budget rather than the sum of every task.
 *
 * @param items - Ordered items to process.
 * @param limit - Shared concurrency limiter.
 * @param mapper - Asynchronous transform applied to each item and its index.
 *
 * @returns Results in the same order as `items`.
 */
export async function mapWithLimit<T, R>(
  items: T[],
  limit: Limiter,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  return Promise.all(
    items.map((item, index) => limit(() => mapper(item, index))),
  );
}

/**
 * Convert an artifact section to the prompt's data-only excerpt shape.
 *
 * @param section - Artifact section selected for a judgment.
 *
 * @returns Serializable excerpt supplied to the model.
 */
export function toExcerpt(section: ArtifactSection): EvaluationExcerpt {
  return {
    sectionId: section.id,
    relativePath: section.relativePath,
    headingPath: section.headingPath,
    content: section.content,
  };
}
