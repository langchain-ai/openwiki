// Deterministic authoring script for the `taskflow` LEDGER benchmark (v2).
//
// Rebuilds the choreographed git history into `repo.bundle` next to this file,
// with a pinned author/committer identity and fixed dates so the checkpoint
// commit SHAs are reproducible across machines. Run it with `node build-repo.mjs`;
// it prints the five checkpoint SHAs to fold into `benchmark.json`.
//
// The history covers taskflow 0.1.0 (T0) through 1.0.0 (T4) across ~37 commits,
// 8 per update gap, so the diff the base system must digest between checkpoints
// is large and lifelike. It carries three signature-stable bug fixes, a transient
// add-then-revert, a store rename + file move, an experimental RedisStore feature
// that is reverted a checkpoint later, and a resurrected TaskError class. The arc
// is deliberately adversarial; see misc/taskflow-v2-benchmark-plan.md for the trap
// catalog.
//
// Two grading channels shape every trap:
//   - The deterministic census (benchmark/surface.ts) sees only top-level
//     exports, one item per source file, and the version, so every structural
//     hazard (rename, move, removal, resurrection, signature change) is planted
//     at the top-level-export layer and graded model-free.
//   - Precision grounds each wiki claim against a checkpoint-folded corpus of all
//     tracked source text (code AND docstrings AND README). The three bug fixes
//     (LIFO to FIFO dequeue, batched to streaming worker pool, off-by-one retry
//     backoff) flip behavior under an IDENTICAL signature, so they are invisible
//     to the census and reachable only as precision staleness once the wiki has
//     documented the buggy behavior. The distributed-workers docstring at T4 is a
//     code-authoritative hallucination the single in-memory loop refutes.
//
// Safety: every git call uses execFileSync with an explicit argument array and
// no shell; all writes land inside a fresh os.tmpdir workspace or this benchmark
// directory; the embedded library sources are static text, never evaluated, and
// contain no backticks or template interpolation so they survive verbatim inside
// these template literals.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { env, stdout } from "node:process";
import { fileURLToPath } from "node:url";

const benchmarkDir = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(benchmarkDir, "repo.bundle");

/** Pinned identity so commit hashes do not depend on the local git config. */
const IDENTITY = {
  GIT_AUTHOR_NAME: "taskflow-bot",
  GIT_AUTHOR_EMAIL: "bot@taskflow.example",
  GIT_COMMITTER_NAME: "taskflow-bot",
  GIT_COMMITTER_EMAIL: "bot@taskflow.example",
};

/**
 * Run a git subcommand inside `cwd`, returning trimmed stdout.
 *
 * @param {string} cwd - Working tree the command runs against.
 * @param {string[]} args - Git arguments, passed without a shell.
 * @param {Record<string, string>} [extraEnv] - Extra environment overrides.
 * @returns {string} Trimmed stdout.
 */
function git(cwd, args, extraEnv = {}) {
  return execFileSync("git", ["-C", cwd, ...args], {
    env: { ...env, ...IDENTITY, ...extraEnv },
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  }).trim();
}

// ---------------------------------------------------------------------------
// Static, non-source scaffolding.
// ---------------------------------------------------------------------------

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
`;

const PRETTIERRC = `{
  "singleQuote": false,
  "trailingComma": "all"
}
`;

const PRETTIERRC_WIDE = `{
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 100
}
`;

/**
 * Render a package.json at a given version. Kept as a function so a version bump
 * is a one-line change rather than a fresh snapshot.
 *
 * @param {string} version - Semantic version string.
 * @param {string} [vitest] - vitest devDependency range; bumped once as noise.
 * @returns {string} package.json content.
 */
function pkg(version, vitest = "1.6.0") {
  return `{
  "name": "taskflow",
  "version": "${version}",
  "description": "An in-memory task queue.",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "${vitest}"
  },
  "license": "MIT"
}
`;
}

// ---------------------------------------------------------------------------
// src/index.ts snapshots. Star re-exports contribute no phantom symbols to the
// census, so the surface always attributes a symbol to its real declaration
// file. VERSION is read as the library version, not as an ordinary symbol.
// ---------------------------------------------------------------------------

/**
 * Render src/index.ts for a version and an ordered list of re-exported modules.
 *
 * @param {string} version - Semantic version string.
 * @param {string[]} modules - Module specifiers to star-re-export.
 * @returns {string} index.ts content.
 */
function indexTs(version, modules) {
  const reexports = modules
    .map((specifier) => `export * from "${specifier}";`)
    .join("\n");
  return `/**
 * Public entry point for the taskflow in-memory task queue.
 */
export const VERSION = "${version}";

${reexports}
`;
}

const IDX_SCAFFOLD = indexTs("0.1.0", []);
const IDX_TASK = indexTs("0.1.0", ["./task.js"]);
const IDX_TASK_QUEUE = indexTs("0.1.0", ["./task.js", "./queue.js"]);
const IDX_T0 = indexTs("0.1.0", ["./task.js", "./queue.js", "./worker.js"]);
const IDX_T1_STORE = indexTs("0.1.0", [
  "./task.js",
  "./queue.js",
  "./worker.js",
  "./store.js",
]);
const IDX_T1 = indexTs("0.2.0", [
  "./task.js",
  "./queue.js",
  "./worker.js",
  "./store.js",
]);
const IDX_T2_RETRY = indexTs("0.2.0", [
  "./task.js",
  "./queue.js",
  "./worker.js",
  "./store.js",
  "./retry.js",
]);
const IDX_T2_EVENTS = indexTs("0.2.0", [
  "./task.js",
  "./queue.js",
  "./worker.js",
  "./store.js",
  "./retry.js",
  "./events.js",
]);
const IDX_T2_STORE_IFACE = indexTs("0.2.0", [
  "./task.js",
  "./queue.js",
  "./worker.js",
  "./store/store.js",
  "./store.js",
  "./retry.js",
  "./events.js",
]);
const IDX_T2_STORE_MOVED = indexTs("0.2.0", [
  "./task.js",
  "./queue.js",
  "./worker.js",
  "./store/store.js",
  "./store/in-memory-store.js",
  "./retry.js",
  "./events.js",
]);
const IDX_T2 = indexTs("0.3.0", [
  "./task.js",
  "./queue.js",
  "./worker.js",
  "./store/store.js",
  "./store/in-memory-store.js",
  "./retry.js",
  "./events.js",
]);
const IDX_T3_SCHED = indexTs("0.3.0", [
  "./task.js",
  "./queue.js",
  "./worker.js",
  "./store/store.js",
  "./store/in-memory-store.js",
  "./retry.js",
  "./events.js",
  "./scheduler.js",
]);
const IDX_T3_REDIS = indexTs("0.3.0", [
  "./task.js",
  "./queue.js",
  "./worker.js",
  "./store/store.js",
  "./store/in-memory-store.js",
  "./store/redis-store.js",
  "./retry.js",
  "./events.js",
  "./scheduler.js",
]);
const IDX_T3 = indexTs("0.4.0", [
  "./task.js",
  "./queue.js",
  "./worker.js",
  "./store/store.js",
  "./store/in-memory-store.js",
  "./store/redis-store.js",
  "./retry.js",
  "./events.js",
  "./scheduler.js",
]);
const IDX_T4_NOREDIS = indexTs("0.4.0", [
  "./task.js",
  "./queue.js",
  "./worker.js",
  "./store/store.js",
  "./store/in-memory-store.js",
  "./retry.js",
  "./events.js",
  "./scheduler.js",
]);
const IDX_T4_METRICS = indexTs("0.4.0", [
  "./task.js",
  "./queue.js",
  "./worker.js",
  "./store/store.js",
  "./store/in-memory-store.js",
  "./retry.js",
  "./events.js",
  "./scheduler.js",
  "./metrics.js",
]);
const IDX_T4_PQ = indexTs("0.4.0", [
  "./task.js",
  "./queue.js",
  "./worker.js",
  "./store/store.js",
  "./store/in-memory-store.js",
  "./retry.js",
  "./events.js",
  "./scheduler.js",
  "./metrics.js",
  "./persistent-queue.js",
]);
const IDX_T4 = indexTs("1.0.0", [
  "./task.js",
  "./queue.js",
  "./worker.js",
  "./store/store.js",
  "./store/in-memory-store.js",
  "./retry.js",
  "./events.js",
  "./scheduler.js",
  "./metrics.js",
  "./persistent-queue.js",
]);

// ---------------------------------------------------------------------------
// src/task.ts snapshots.
// ---------------------------------------------------------------------------

const TASK_T0 = `/**
 * Lifecycle state of a task as it moves through the queue.
 */
export enum TaskState {
  pending,
  running,
  succeeded,
  failed,
}

/**
 * A unit of work submitted to the queue.
 */
export interface Task {
  /** Stable identifier for the task. */
  id: string;

  /** Opaque work payload handed to the task handler. */
  payload: unknown;
}

/**
 * Error thrown when a running task's handler rejects or throws. This is the
 * execution error: it signals a failure that happened while the task was being
 * processed, not a problem with the task's definition.
 */
export class TaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskError";
  }
}
`;

const TASK_PRIORITY = `/**
 * Relative scheduling priority for a task. Higher priorities are drained first.
 */
export enum Priority {
  low,
  normal,
  high,
}

/**
 * Lifecycle state of a task as it moves through the queue.
 */
export enum TaskState {
  pending,
  running,
  succeeded,
  failed,
}

/**
 * A unit of work submitted to the queue.
 */
export interface Task {
  /** Stable identifier for the task. */
  id: string;

  /** Opaque work payload handed to the task handler. */
  payload: unknown;

  /** Relative scheduling priority; defaults to normal when omitted. */
  priority?: Priority;
}

/**
 * Error thrown when a running task's handler rejects or throws (execution
 * error).
 */
export class TaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskError";
  }
}
`;

// The execution error is renamed to TaskExecutionError, with the old name kept
// as a deprecated alias for one release so downstream imports keep working.
const TASK_ALIAS = `/**
 * Relative scheduling priority for a task. Higher priorities are drained first.
 */
export enum Priority {
  low,
  normal,
  high,
}

/**
 * Lifecycle state of a task as it moves through the queue.
 */
export enum TaskState {
  pending,
  running,
  succeeded,
  failed,
}

/**
 * A unit of work submitted to the queue.
 */
export interface Task {
  /** Stable identifier for the task. */
  id: string;

  /** Opaque work payload handed to the task handler. */
  payload: unknown;

  /** Relative scheduling priority; defaults to normal when omitted. */
  priority?: Priority;
}

/**
 * Error thrown when a running task's handler rejects or throws (execution
 * error). Renamed from TaskError; the old name remains as a deprecated alias
 * for one release so downstream imports keep working.
 */
export class TaskExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskExecutionError";
  }
}

/**
 * Deprecated alias for TaskExecutionError. Prefer TaskExecutionError in new
 * code; TaskError will be removed in a future release.
 */
export { TaskExecutionError as TaskError };
`;

// The deprecated alias is dropped: TaskError disappears from task.ts entirely
// (it is resurrected with a different meaning in scheduler.ts at T4).
const TASK_NO_ALIAS = `/**
 * Relative scheduling priority for a task. Higher priorities are drained first.
 */
export enum Priority {
  low,
  normal,
  high,
}

/**
 * Lifecycle state of a task as it moves through the queue.
 */
export enum TaskState {
  pending,
  running,
  succeeded,
  failed,
}

/**
 * A unit of work submitted to the queue.
 */
export interface Task {
  /** Stable identifier for the task. */
  id: string;

  /** Opaque work payload handed to the task handler. */
  payload: unknown;

  /** Relative scheduling priority; defaults to normal when omitted. */
  priority?: Priority;
}

/**
 * Error thrown when a running task's handler rejects or throws (execution
 * error).
 */
export class TaskExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskExecutionError";
  }
}
`;

// ---------------------------------------------------------------------------
// src/queue.ts snapshots. T0 ships a real FIFO bug: dequeue returns the MOST
// recently enqueued task (pop, LIFO) while the docstring and README promise
// first-in-first-out. The fix restores FIFO; a later commit adds real priority
// ordering with arrival order breaking ties, so the FIFO fix survives. dequeue's
// signature never changes, so the census sees queue.ts as stable across the fix
// and the priority change: both are precision-only.
// ---------------------------------------------------------------------------

const QUEUE_T0_LIFO_BUG = `import type { Task } from "./task.js";

/**
 * A first-in-first-out task queue. The task waiting longest is always the next
 * one returned by dequeue.
 */
export class Queue {
  /** Tasks currently waiting, oldest first. */
  tasks: Task[] = [];
}

/**
 * Create an empty queue.
 */
export function createQueue(): Queue {
  return new Queue();
}

/**
 * Add a task to the back of the queue.
 */
export function enqueue(queue: Queue, task: Task): void {
  queue.tasks.push(task);
}

/**
 * Remove and return the task that has waited longest, or undefined when the
 * queue is empty.
 */
export function dequeue(queue: Queue): Task | undefined {
  return queue.tasks.pop();
}

/**
 * The number of tasks currently waiting.
 */
export function size(queue: Queue): number {
  return queue.tasks.length;
}
`;

const QUEUE_FIFO_FIXED = `import type { Task } from "./task.js";

/**
 * A first-in-first-out task queue. The task waiting longest is always the next
 * one returned by dequeue.
 */
export class Queue {
  /** Tasks currently waiting, oldest first. */
  tasks: Task[] = [];
}

/**
 * Create an empty queue.
 */
export function createQueue(): Queue {
  return new Queue();
}

/**
 * Add a task to the back of the queue.
 */
export function enqueue(queue: Queue, task: Task): void {
  queue.tasks.push(task);
}

/**
 * Remove and return the task that has waited longest, or undefined when the
 * queue is empty.
 */
export function dequeue(queue: Queue): Task | undefined {
  return queue.tasks.shift();
}

/**
 * The number of tasks currently waiting.
 */
export function size(queue: Queue): number {
  return queue.tasks.length;
}
`;

const QUEUE_PRIORITY_PARAM = `import { Priority, type Task } from "./task.js";

/**
 * A task queue. Tasks are drained in priority order, with arrival order breaking
 * ties, so equal-priority tasks still leave first-in-first-out.
 */
export class Queue {
  /** Tasks currently waiting, oldest first. */
  tasks: Task[] = [];
}

/**
 * Create an empty queue.
 */
export function createQueue(): Queue {
  return new Queue();
}

/**
 * Add a task to the queue with an explicit priority.
 */
export function enqueue(
  queue: Queue,
  task: Task,
  priority: Priority = Priority.normal,
): void {
  task.priority = priority;
  queue.tasks.push(task);
}

/**
 * Remove and return the task that has waited longest, or undefined when the
 * queue is empty.
 */
export function dequeue(queue: Queue): Task | undefined {
  return queue.tasks.shift();
}

/**
 * The number of tasks currently waiting.
 */
export function size(queue: Queue): number {
  return queue.tasks.length;
}
`;

const QUEUE_PRIORITY = `import { Priority, type Task } from "./task.js";

/**
 * A task queue. Tasks are drained in priority order, with arrival order breaking
 * ties, so equal-priority tasks still leave first-in-first-out.
 */
export class Queue {
  /** Tasks currently waiting, oldest first. */
  tasks: Task[] = [];
}

/**
 * Create an empty queue.
 */
export function createQueue(): Queue {
  return new Queue();
}

/**
 * Add a task to the queue with an explicit priority.
 */
export function enqueue(
  queue: Queue,
  task: Task,
  priority: Priority = Priority.normal,
): void {
  task.priority = priority;
  queue.tasks.push(task);
}

/**
 * Remove and return the highest-priority task waiting, or undefined when the
 * queue is empty. Ties are broken by arrival order.
 */
export function dequeue(queue: Queue): Task | undefined {
  if (queue.tasks.length === 0) {
    return undefined;
  }
  let best = 0;
  for (let i = 1; i < queue.tasks.length; i += 1) {
    const candidate = queue.tasks[i].priority ?? Priority.normal;
    const winner = queue.tasks[best].priority ?? Priority.normal;
    if (candidate > winner) {
      best = i;
    }
  }
  return queue.tasks.splice(best, 1)[0];
}

/**
 * The number of tasks currently waiting.
 */
export function size(queue: Queue): number {
  return queue.tasks.length;
}
`;

// Transient: a clear() helper added mid-gap, then git-reverted before the T1
// release. It must never reach a tagged surface.
const QUEUE_PRIORITY_CLEAR = `import { Priority, type Task } from "./task.js";

/**
 * A task queue. Tasks are drained in priority order, with arrival order breaking
 * ties, so equal-priority tasks still leave first-in-first-out.
 */
export class Queue {
  /** Tasks currently waiting, oldest first. */
  tasks: Task[] = [];
}

/**
 * Create an empty queue.
 */
export function createQueue(): Queue {
  return new Queue();
}

/**
 * Add a task to the queue with an explicit priority.
 */
export function enqueue(
  queue: Queue,
  task: Task,
  priority: Priority = Priority.normal,
): void {
  task.priority = priority;
  queue.tasks.push(task);
}

/**
 * Remove and return the highest-priority task waiting, or undefined when the
 * queue is empty. Ties are broken by arrival order.
 */
export function dequeue(queue: Queue): Task | undefined {
  if (queue.tasks.length === 0) {
    return undefined;
  }
  let best = 0;
  for (let i = 1; i < queue.tasks.length; i += 1) {
    const candidate = queue.tasks[i].priority ?? Priority.normal;
    const winner = queue.tasks[best].priority ?? Priority.normal;
    if (candidate > winner) {
      best = i;
    }
  }
  return queue.tasks.splice(best, 1)[0];
}

/**
 * The number of tasks currently waiting.
 */
export function size(queue: Queue): number {
  return queue.tasks.length;
}

/**
 * Remove every waiting task from the queue.
 */
export function clear(queue: Queue): void {
  queue.tasks.length = 0;
}
`;

// ---------------------------------------------------------------------------
// src/worker.ts snapshots. T0 is strictly sequential. T1 grows a worker pool
// with a concurrency parameter, but the pool has a real throughput bug: it fills
// a batch of `concurrency` tasks and blocks on the WHOLE batch before starting
// the next, so one slow task stalls every other slot (head-of-line blocking).
// The T2 fix streams work, refilling each slot as soon as it frees. runWorker's
// signature is identical across the fix, so it is precision-only.
// ---------------------------------------------------------------------------

const WORKER_SEQUENTIAL = `import { dequeue, type Queue } from "./queue.js";
import { TaskError, type Task } from "./task.js";

/**
 * Executes tasks pulled from a queue.
 */
export class Worker {
  running = false;
}

/**
 * Drain the queue, running each task to completion one at a time before
 * starting the next (strictly sequential).
 */
export async function runWorker(worker: Worker, queue: Queue): Promise<void> {
  worker.running = true;
  let task: Task | undefined = dequeue(queue);
  while (task !== undefined) {
    await handle(task);
    task = dequeue(queue);
  }
  worker.running = false;
}

/**
 * Run one task, wrapping any thrown value as a TaskError.
 */
async function handle(task: Task): Promise<void> {
  try {
    void task;
  } catch (cause) {
    throw new TaskError("task failed: " + String(cause));
  }
}
`;

const WORKER_POOL_BATCHED = `import { dequeue, type Queue } from "./queue.js";
import { TaskError, type Task } from "./task.js";

/**
 * Executes tasks pulled from a queue.
 */
export class Worker {
  running = false;
}

/**
 * Drain the queue across a pool of up to concurrency tasks running at once.
 */
export async function runWorker(
  worker: Worker,
  queue: Queue,
  concurrency: number = 1,
): Promise<void> {
  worker.running = true;
  let batch: Array<Promise<void>> = [];
  let task: Task | undefined = dequeue(queue);
  while (task !== undefined) {
    batch.push(handle(task));
    if (batch.length >= concurrency) {
      await Promise.all(batch);
      batch = [];
    }
    task = dequeue(queue);
  }
  await Promise.all(batch);
  worker.running = false;
}

/**
 * Run one task, wrapping any thrown value as a TaskError.
 */
async function handle(task: Task): Promise<void> {
  try {
    void task;
  } catch (cause) {
    throw new TaskError("task failed: " + String(cause));
  }
}
`;

const WORKER_POOL_STREAMING = `import { dequeue, type Queue } from "./queue.js";
import { TaskError, type Task } from "./task.js";

/**
 * Executes tasks pulled from a queue.
 */
export class Worker {
  running = false;
}

/**
 * Drain the queue across a pool of up to concurrency tasks running at once,
 * refilling each slot as soon as its task finishes rather than waiting for the
 * whole batch.
 */
export async function runWorker(
  worker: Worker,
  queue: Queue,
  concurrency: number = 1,
): Promise<void> {
  worker.running = true;
  const inFlight = new Set<Promise<void>>();
  let task: Task | undefined = dequeue(queue);
  while (task !== undefined) {
    const slot: Promise<void> = handle(task).then(() => {
      inFlight.delete(slot);
    });
    inFlight.add(slot);
    if (inFlight.size >= concurrency) {
      await Promise.race(inFlight);
    }
    task = dequeue(queue);
  }
  await Promise.all(inFlight);
  worker.running = false;
}

/**
 * Run one task, wrapping any thrown value as a TaskError.
 */
async function handle(task: Task): Promise<void> {
  try {
    void task;
  } catch (cause) {
    throw new TaskError("task failed: " + String(cause));
  }
}
`;

// The worker imports the renamed execution error once TaskError becomes an alias
// for TaskExecutionError; behavior is unchanged, this only tracks the rename.
const WORKER_POOL_RENAMED_ERROR = `import { dequeue, type Queue } from "./queue.js";
import { TaskExecutionError, type Task } from "./task.js";

/**
 * Executes tasks pulled from a queue.
 */
export class Worker {
  running = false;
}

/**
 * Drain the queue across a pool of up to concurrency tasks running at once,
 * refilling each slot as soon as its task finishes rather than waiting for the
 * whole batch.
 */
export async function runWorker(
  worker: Worker,
  queue: Queue,
  concurrency: number = 1,
): Promise<void> {
  worker.running = true;
  const inFlight = new Set<Promise<void>>();
  let task: Task | undefined = dequeue(queue);
  while (task !== undefined) {
    const slot: Promise<void> = handle(task).then(() => {
      inFlight.delete(slot);
    });
    inFlight.add(slot);
    if (inFlight.size >= concurrency) {
      await Promise.race(inFlight);
    }
    task = dequeue(queue);
  }
  await Promise.all(inFlight);
  worker.running = false;
}

/**
 * Run one task, wrapping any thrown value as a TaskExecutionError.
 */
async function handle(task: Task): Promise<void> {
  try {
    void task;
  } catch (cause) {
    throw new TaskExecutionError("task failed: " + String(cause));
  }
}
`;

// ---------------------------------------------------------------------------
// src/store.ts (T1) then src/store/*.ts (T2). MemoryStore is a standalone class
// at T1. At T2 a Store interface is extracted and MemoryStore is renamed to
// InMemoryStore and moved under src/store/, so the census sees MemoryStore (and
// its file) removed and Store + InMemoryStore introduced.
// ---------------------------------------------------------------------------

const STORE_MEMORY = `import type { Task } from "./task.js";

/**
 * Keeps finished task results in memory, keyed by task id.
 */
export class MemoryStore {
  private readonly results = new Map<string, unknown>();

  /** Record the result of a finished task. */
  save(task: Task, result: unknown): void {
    this.results.set(task.id, result);
  }

  /** Read a previously saved result, or undefined if none was stored. */
  load(id: string): unknown {
    return this.results.get(id);
  }
}
`;

const STORE_INTERFACE = `import type { Task } from "../task.js";

/**
 * A pluggable backing store for finished task results.
 */
export interface Store {
  /** Record the result of a finished task. */
  save(task: Task, result: unknown): void;

  /** Read a previously saved result, or undefined if none was stored. */
  load(id: string): unknown;
}
`;

const STORE_IN_MEMORY = `import type { Task } from "../task.js";
import type { Store } from "./store.js";

/**
 * A Store that keeps finished task results in process memory, keyed by task id.
 * Renamed from MemoryStore in 0.3.0.
 */
export class InMemoryStore implements Store {
  private readonly results = new Map<string, unknown>();

  save(task: Task, result: unknown): void {
    this.results.set(task.id, result);
  }

  load(id: string): unknown {
    return this.results.get(id);
  }
}
`;

const STORE_REDIS = `import type { Task } from "../task.js";
import type { Store } from "./store.js";

/**
 * EXPERIMENTAL. A Store backed by Redis so results survive a process restart.
 * This is a best-effort stub: it buffers writes in memory and does not yet talk
 * to a real Redis server. Do not rely on it in production.
 */
export class RedisStore implements Store {
  private readonly buffer = new Map<string, unknown>();
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  save(task: Task, result: unknown): void {
    this.buffer.set(task.id, result);
  }

  load(id: string): unknown {
    return this.buffer.get(id);
  }
}
`;

// ---------------------------------------------------------------------------
// src/retry.ts snapshots. withRetry computes an exponential backoff. T2 ships an
// off-by-one: the exponent starts at 1, so the first retry already waits twice
// baseDelayMs instead of exactly baseDelayMs. The T3 fix starts the exponent at
// 0. withRetry's signature is identical across the fix (precision-only).
// ---------------------------------------------------------------------------

const RETRY_OFF_BY_ONE = `/**
 * Controls how a failed task is retried.
 */
export interface RetryPolicy {
  /** Maximum number of retry attempts after the first failure. */
  retries: number;

  /** Base delay in milliseconds; the first retry waits exactly this long. */
  baseDelayMs: number;
}

/**
 * Thrown when a task still fails after its retry policy is exhausted.
 */
export class RetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryError";
  }
}

/**
 * The delay before retry attempt number \`attempt\` (1-based), using exponential
 * backoff: the first retry waits baseDelayMs, then each subsequent retry doubles.
 */
export function backoffDelay(policy: RetryPolicy, attempt: number): number {
  return policy.baseDelayMs * 2 ** attempt;
}

/**
 * Run \`work\`, retrying on failure per the policy with exponential backoff.
 */
export async function withRetry(
  policy: RetryPolicy,
  work: () => Promise<void>,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.retries + 1; attempt += 1) {
    try {
      await work();
      return;
    } catch (cause) {
      lastError = cause;
      void backoffDelay(policy, attempt);
    }
  }
  throw new RetryError("retries exhausted: " + String(lastError));
}
`;

const RETRY_FIXED = `/**
 * Controls how a failed task is retried.
 */
export interface RetryPolicy {
  /** Maximum number of retry attempts after the first failure. */
  retries: number;

  /** Base delay in milliseconds; the first retry waits exactly this long. */
  baseDelayMs: number;
}

/**
 * Thrown when a task still fails after its retry policy is exhausted.
 */
export class RetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryError";
  }
}

/**
 * The delay before retry attempt number \`attempt\` (1-based), using exponential
 * backoff: the first retry waits baseDelayMs, then each subsequent retry doubles.
 */
export function backoffDelay(policy: RetryPolicy, attempt: number): number {
  return policy.baseDelayMs * 2 ** (attempt - 1);
}

/**
 * Run \`work\`, retrying on failure per the policy with exponential backoff.
 */
export async function withRetry(
  policy: RetryPolicy,
  work: () => Promise<void>,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.retries + 1; attempt += 1) {
    try {
      await work();
      return;
    } catch (cause) {
      lastError = cause;
      void backoffDelay(policy, attempt);
    }
  }
  throw new RetryError("retries exhausted: " + String(lastError));
}
`;

// ---------------------------------------------------------------------------
// src/events.ts snapshot. A tiny lifecycle event bus.
// ---------------------------------------------------------------------------

const EVENTS = `import type { Task } from "./task.js";

/**
 * A lifecycle event emitted as a task moves through the queue.
 */
export interface TaskEvent {
  /** What happened, for example "started" or "succeeded". */
  kind: string;

  /** The task the event concerns. */
  task: Task;
}

/**
 * A minimal synchronous event bus for task lifecycle events.
 */
export class EventBus {
  readonly listeners: Array<(event: TaskEvent) => void> = [];
}

/**
 * Register a listener for every task lifecycle event.
 */
export function subscribe(
  bus: EventBus,
  listener: (event: TaskEvent) => void,
): void {
  bus.listeners.push(listener);
}

/**
 * Deliver an event to every registered listener, in registration order.
 */
export function publish(bus: EventBus, event: TaskEvent): void {
  for (const listener of bus.listeners) {
    listener(event);
  }
}
`;

// ---------------------------------------------------------------------------
// src/scheduler.ts snapshots. Introduced at T3 with a dead-letter queue. At T4
// it gains a resurrected TaskError (now a VALIDATION error, distinct from the
// buried execution error), an options parameter whose retries default flips to
// 3, and a docstring that overclaims distributed workers the in-memory loop does
// not implement.
// ---------------------------------------------------------------------------

const SCHED_T3 = `import { Priority, type Task } from "./task.js";

/**
 * The scheduler front door. Holds tasks in memory and drains them by priority
 * through a single worker loop.
 */
export class Scheduler {
  tasks: Task[] = [];
  concurrency: number;

  constructor(concurrency: number) {
    this.concurrency = concurrency;
  }
}

/**
 * A holding area for tasks that have exhausted their retry policy.
 */
export class DeadLetterQueue {
  readonly dead: Task[] = [];

  /** Move a permanently failed task into the dead-letter queue. */
  bury(task: Task): void {
    this.dead.push(task);
  }
}

/**
 * Create a scheduler with an optional worker concurrency (defaults to 1).
 */
export function createScheduler(concurrency: number = 1): Scheduler {
  return new Scheduler(concurrency);
}

/**
 * Submit a task to the scheduler at an optional priority.
 */
export function schedule(
  scheduler: Scheduler,
  task: Task,
  priority: Priority = Priority.normal,
): void {
  task.priority = priority;
  scheduler.tasks.push(task);
}
`;

const SCHED_T4 = `import { Priority, type Task } from "./task.js";

/**
 * The scheduler front door. Distributes tasks across worker processes so a fleet
 * of machines drains the queue and the scheduler scales horizontally across a
 * cluster.
 */
export class Scheduler {
  tasks: Task[] = [];
  concurrency: number;

  constructor(concurrency: number) {
    this.concurrency = concurrency;
  }
}

/**
 * A holding area for tasks that have exhausted their retry policy.
 */
export class DeadLetterQueue {
  readonly dead: Task[] = [];

  /** Move a permanently failed task into the dead-letter queue. */
  bury(task: Task): void {
    this.dead.push(task);
  }
}

/**
 * Create a scheduler with an optional worker concurrency (defaults to 1).
 */
export function createScheduler(concurrency: number = 1): Scheduler {
  return new Scheduler(concurrency);
}

/**
 * Submit a task to the scheduler at an optional priority. Failed tasks are
 * retried automatically; retries default to 3.
 */
export function schedule(
  scheduler: Scheduler,
  task: Task,
  priority: Priority = Priority.normal,
  options: { retries?: number } = {},
): void {
  const retries = options.retries ?? 3;
  void retries;
  if (task.id === "") {
    throw new TaskError("task is missing an id");
  }
  task.priority = priority;
  scheduler.tasks.push(task);
}

/**
 * Error thrown by schedule() when a task is missing an id. This is a validation
 * error raised before the task ever runs, distinct from an execution failure.
 */
export class TaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskError";
  }
}
`;

// ---------------------------------------------------------------------------
// src/metrics.ts and src/persistent-queue.ts (T4).
// ---------------------------------------------------------------------------

const METRICS = `import type { Scheduler } from "./scheduler.js";

/**
 * A point-in-time snapshot of scheduler activity.
 */
export interface SchedulerMetrics {
  queued: number;
  running: number;
  completed: number;
}

/**
 * Read the current metrics for a scheduler.
 */
export function metrics(scheduler: Scheduler): SchedulerMetrics {
  return { queued: scheduler.tasks.length, running: 0, completed: 0 };
}
`;

const PERSISTENT_QUEUE = `import type { Task } from "./task.js";

/**
 * A queue whose contents survive process restarts by persisting to disk.
 */
export class PersistentQueue {
  tasks: Task[] = [];
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }
}

/**
 * Open (or create) a persistent queue backed by the file at the given path.
 */
export function openPersistentQueue(path: string): PersistentQueue {
  return new PersistentQueue(path);
}
`;

// ---------------------------------------------------------------------------
// Prose. The README tracks the honest evolving public story, except the T4
// distributed-workers line, which restates the code-authoritative lie in the
// Scheduler docstring so both channels agree it is unsupported.
// ---------------------------------------------------------------------------

const README_T0 = `# taskflow

An in-memory task queue.

Tasks are processed first-in-first-out: the task that has waited longest is
always the next one to run.

## Usage

Create a queue with createQueue, add tasks with enqueue, and drain them by
running a worker with runWorker.
`;

const README_T1 = `# taskflow

An in-memory task queue.

Tasks are drained in priority order. Assign a Priority when enqueuing; higher
priorities run first, and equal priorities keep first-in-first-out order.

## Usage

Create a queue with createQueue, add tasks with enqueue, and drain them by
running a worker pool with runWorker (pass a concurrency to run several tasks at
once). Finished results can be kept in a MemoryStore.
`;

const README_T2 = `# taskflow

An in-memory task queue.

Tasks are drained in priority order across a worker pool. Failed tasks can be
retried with a RetryPolicy, and lifecycle events are delivered through an
EventBus.

## Usage

Create a queue with createQueue and drain it with runWorker. Keep finished
results in any Store; the built-in InMemoryStore keeps them in process memory.
`;

const README_T3 = `# taskflow

An in-memory task queue.

Use the Scheduler front door: create one with createScheduler, then hand it work
with schedule. Tasks that exhaust their retries land in a DeadLetterQueue.

## Usage

Results can be kept in an InMemoryStore, or, experimentally, a RedisStore that
survives restarts. Retry failed work with withRetry and a RetryPolicy.
`;

const README_T4 = `# taskflow

A task queue.

Workers are distributed across processes so the scheduler scales horizontally
across a cluster of machines.

## Usage

Use createScheduler and schedule. Failed tasks are retried automatically.
Persist work across restarts with openPersistentQueue, and read live counters
with metrics.
`;

// ---------------------------------------------------------------------------
// Tests. Outside tsconfig's include, so they never break a checkpoint build and
// never contribute to the census, but they do join the precision evidence
// corpus (which folds all tracked text).
// ---------------------------------------------------------------------------

const TEST_T0 = `import { createQueue, dequeue, enqueue, size } from "../src/queue.js";

const q = createQueue();
enqueue(q, { id: "a", payload: 1 });
enqueue(q, { id: "b", payload: 2 });
if (size(q) !== 2) {
  throw new Error("expected two waiting tasks");
}
if (dequeue(q) === undefined) {
  throw new Error("expected a task");
}
`;

const TEST_T1 = `import { createQueue, dequeue, enqueue } from "../src/queue.js";
import { Priority } from "../src/task.js";

const q = createQueue();
enqueue(q, { id: "a", payload: 1 }, Priority.high);
if (dequeue(q) === undefined) {
  throw new Error("expected a task");
}
`;

const TEST_T2 = `import { InMemoryStore } from "../src/store/in-memory-store.js";
import { withRetry, type RetryPolicy } from "../src/retry.js";

const store = new InMemoryStore();
store.save({ id: "a", payload: 1 }, "ok");
if (store.load("a") !== "ok") {
  throw new Error("expected the saved result");
}
const policy: RetryPolicy = { retries: 2, baseDelayMs: 10 };
await withRetry(policy, async () => {});
`;

const TEST_T3 = `import { createScheduler, schedule } from "../src/scheduler.js";
import { Priority } from "../src/task.js";

const scheduler = createScheduler(2);
schedule(scheduler, { id: "a", payload: 1 }, Priority.high);
if (scheduler.tasks.length !== 1) {
  throw new Error("expected one scheduled task");
}
`;

// ---------------------------------------------------------------------------
// Commit choreography. Each step lists only the files it changes; unchanged
// files persist from the previous commit. Only the tree at a tagged checkpoint
// is graded, so intermediate commits carry the transient churn and the bug fixes.
// ---------------------------------------------------------------------------

const steps = [
  // --- T0 (0.1.0): honest MVP with a latent FIFO bug ---------------------
  {
    message: "chore: scaffold taskflow 0.1.0",
    date: "2025-01-06T09:00:00+0000",
    files: {
      "package.json": pkg("0.1.0"),
      "tsconfig.json": TSCONFIG,
      ".prettierrc.json": PRETTIERRC,
      "src/index.ts": IDX_SCAFFOLD,
    },
  },
  {
    message: "feat: task model, TaskState, and TaskError execution error",
    date: "2025-01-07T09:00:00+0000",
    files: {
      "src/task.ts": TASK_T0,
      "src/index.ts": IDX_TASK,
    },
  },
  {
    message: "feat: FIFO queue with enqueue, dequeue, and size",
    date: "2025-01-08T09:00:00+0000",
    files: {
      "src/queue.ts": QUEUE_T0_LIFO_BUG,
      "src/index.ts": IDX_TASK_QUEUE,
    },
  },
  {
    message: "feat: strictly sequential runWorker",
    date: "2025-01-09T09:00:00+0000",
    files: {
      "src/worker.ts": WORKER_SEQUENTIAL,
      "src/index.ts": IDX_T0,
    },
  },
  {
    message: "docs: README and a smoke-test scaffold",
    date: "2025-01-10T09:00:00+0000",
    checkpoint: "T0",
    files: {
      "README.md": README_T0,
      "test/queue.test.ts": TEST_T0,
    },
  },

  // --- T0 -> T1 (0.2.0): FIFO fix, priorities, pool, store, transient clear
  {
    message:
      "fix: dequeue returned the most recently added task, not the oldest",
    date: "2025-02-03T09:00:00+0000",
    files: {
      "src/queue.ts": QUEUE_FIFO_FIXED,
    },
  },
  {
    message: "feat: add a Priority enum and a priority parameter to enqueue",
    date: "2025-02-05T09:00:00+0000",
    files: {
      "src/task.ts": TASK_PRIORITY,
      "src/queue.ts": QUEUE_PRIORITY_PARAM,
    },
  },
  {
    message: "refactor: drain the queue in priority order, ties by arrival",
    date: "2025-02-06T09:00:00+0000",
    files: {
      "src/queue.ts": QUEUE_PRIORITY,
      "README.md": README_T1,
    },
  },
  {
    message: "feat: drain the queue across a worker pool",
    date: "2025-02-08T09:00:00+0000",
    files: {
      "src/worker.ts": WORKER_POOL_BATCHED,
    },
  },
  {
    message: "feat: MemoryStore for finished task results",
    date: "2025-02-10T09:00:00+0000",
    files: {
      "src/store.ts": STORE_MEMORY,
      "src/index.ts": IDX_T1_STORE,
    },
  },
  {
    message: "feat: add clear() to empty a queue",
    date: "2025-02-11T09:00:00+0000",
    files: {
      "src/queue.ts": QUEUE_PRIORITY_CLEAR,
    },
  },
  {
    message: "revert: drop clear(), it duplicates recreating the queue",
    date: "2025-02-12T09:00:00+0000",
    files: {
      "src/queue.ts": QUEUE_PRIORITY,
    },
  },
  {
    message: "release: taskflow 0.2.0 - priorities, worker pool, MemoryStore",
    date: "2025-02-14T09:00:00+0000",
    checkpoint: "T1",
    files: {
      "package.json": pkg("0.2.0"),
      "src/index.ts": IDX_T1,
      "test/queue.test.ts": TEST_T1,
    },
  },

  // --- T1 -> T2 (0.3.0): retries, events, pool fix, Store extraction+rename
  {
    message: "feat: RetryPolicy, RetryError, and withRetry",
    date: "2025-03-03T09:00:00+0000",
    files: {
      "src/retry.ts": RETRY_OFF_BY_ONE,
      "src/index.ts": IDX_T2_RETRY,
    },
  },
  {
    message: "feat: task lifecycle events through an EventBus",
    date: "2025-03-05T09:00:00+0000",
    files: {
      "src/events.ts": EVENTS,
      "src/index.ts": IDX_T2_EVENTS,
    },
  },
  {
    message: "fix: worker pool blocked on a full batch, stalling free slots",
    date: "2025-03-07T09:00:00+0000",
    files: {
      "src/worker.ts": WORKER_POOL_STREAMING,
    },
  },
  {
    message: "refactor: extract a pluggable Store interface",
    date: "2025-03-09T09:00:00+0000",
    files: {
      "src/store/store.ts": STORE_INTERFACE,
      "src/index.ts": IDX_T2_STORE_IFACE,
    },
  },
  {
    message:
      "refactor: rename MemoryStore to InMemoryStore and move under src/store",
    date: "2025-03-11T09:00:00+0000",
    remove: ["src/store.ts"],
    files: {
      "src/store/in-memory-store.ts": STORE_IN_MEMORY,
      "src/index.ts": IDX_T2_STORE_MOVED,
    },
  },
  {
    message: "test: cover the store and retry helpers",
    date: "2025-03-12T09:00:00+0000",
    files: {
      "test/queue.test.ts": TEST_T2,
    },
  },
  {
    message: "chore: widen Prettier printWidth to 100",
    date: "2025-03-13T09:00:00+0000",
    files: {
      ".prettierrc.json": PRETTIERRC_WIDE,
    },
  },
  {
    message: "release: taskflow 0.3.0 - retries, events, pluggable Store",
    date: "2025-03-14T09:00:00+0000",
    checkpoint: "T2",
    files: {
      "package.json": pkg("0.3.0"),
      "src/index.ts": IDX_T2,
      "README.md": README_T2,
    },
  },

  // --- T2 -> T3 (0.4.0): scheduler, dead-letter, experimental Redis, rename,
  //     backoff fix ------------------------------------------------------
  {
    message: "feat: Scheduler front door with a DeadLetterQueue",
    date: "2025-04-02T09:00:00+0000",
    files: {
      "src/scheduler.ts": SCHED_T3,
      "src/index.ts": IDX_T3_SCHED,
    },
  },
  {
    message: "feat: experimental RedisStore backing store",
    date: "2025-04-04T09:00:00+0000",
    files: {
      "src/store/redis-store.ts": STORE_REDIS,
      "src/index.ts": IDX_T3_REDIS,
    },
  },
  {
    message:
      "refactor: rename TaskError to TaskExecutionError with a deprecated alias",
    date: "2025-04-07T09:00:00+0000",
    files: {
      "src/task.ts": TASK_ALIAS,
      "src/worker.ts": WORKER_POOL_RENAMED_ERROR,
    },
  },
  {
    message: "fix: retry backoff doubled the first delay (off-by-one exponent)",
    date: "2025-04-09T09:00:00+0000",
    files: {
      "src/retry.ts": RETRY_FIXED,
    },
  },
  {
    message: "chore: bump vitest to 1.6.1",
    date: "2025-04-11T09:00:00+0000",
    files: {
      "package.json": pkg("0.3.0", "1.6.1"),
    },
  },
  {
    message: "test: schedule places a task on the scheduler",
    date: "2025-04-12T09:00:00+0000",
    files: {
      "test/queue.test.ts": TEST_T3,
    },
  },
  {
    message:
      "release: taskflow 0.4.0 - scheduler, dead-letter, experimental Redis",
    date: "2025-04-14T09:00:00+0000",
    checkpoint: "T3",
    files: {
      "package.json": pkg("0.4.0", "1.6.1"),
      "src/index.ts": IDX_T3,
      "README.md": README_T3,
    },
  },

  // --- T3 -> T4 (1.0.0): revert Redis, metrics, persistence, drop alias,
  //     resurrect TaskError, retries default flip, distributed doc lie ----
  {
    message:
      "revert: remove experimental RedisStore, it proved flaky under load",
    date: "2025-05-05T09:00:00+0000",
    remove: ["src/store/redis-store.ts"],
    files: {
      "src/index.ts": IDX_T4_NOREDIS,
    },
  },
  {
    message: "feat: scheduler metrics",
    date: "2025-05-07T09:00:00+0000",
    files: {
      "src/metrics.ts": METRICS,
      "src/index.ts": IDX_T4_METRICS,
    },
  },
  {
    message: "feat: PersistentQueue and openPersistentQueue",
    date: "2025-05-09T09:00:00+0000",
    files: {
      "src/persistent-queue.ts": PERSISTENT_QUEUE,
      "src/index.ts": IDX_T4_PQ,
    },
  },
  {
    message: "refactor: drop the deprecated TaskError alias",
    date: "2025-05-11T09:00:00+0000",
    files: {
      "src/task.ts": TASK_NO_ALIAS,
    },
  },
  {
    message: "feat: TaskError, now a validation error thrown by schedule()",
    date: "2025-05-13T09:00:00+0000",
    files: {
      "src/scheduler.ts": SCHED_T4,
    },
  },
  {
    message: "docs: describe the distributed, horizontally scaled scheduler",
    date: "2025-05-15T09:00:00+0000",
    files: {
      "README.md": README_T4,
    },
  },
  {
    message:
      "release: taskflow 1.0.0 - metrics, persistence, retries default to 3",
    date: "2025-05-16T09:00:00+0000",
    checkpoint: "T4",
    files: {
      "package.json": pkg("1.0.0", "1.6.1"),
      "src/index.ts": IDX_T4,
    },
  },
];

/**
 * Write every file in `files` under `root`, creating parent directories.
 *
 * @param {string} root - Working-tree root.
 * @param {Record<string, string>} files - Relative path to file content.
 */
function writeAll(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

const work = mkdtempSync(path.join(tmpdir(), "taskflow-build-"));
try {
  git(work, ["init", "-q", "-b", "main"]);

  let current = {};
  const shas = {};
  for (const step of steps) {
    current = { ...current, ...step.files };
    for (const rel of step.remove ?? []) {
      delete current[rel];
      rmSync(path.join(work, rel), { force: true });
    }
    writeAll(work, current);
    git(work, ["add", "-A"]);
    git(work, ["commit", "-q", "-m", step.message], {
      GIT_AUTHOR_DATE: step.date,
      GIT_COMMITTER_DATE: step.date,
    });
    if (step.checkpoint) {
      shas[step.checkpoint] = git(work, ["rev-parse", "HEAD"]);
    }
  }

  rmSync(bundlePath, { force: true });
  git(work, ["bundle", "create", bundlePath, "--all"]);

  stdout.write(JSON.stringify(shas, null, 2) + "\n");
} finally {
  // Retry the teardown: git can briefly hold objects under .git on some
  // filesystems, which otherwise surfaces as a spurious ENOTEMPTY.
  rmSync(work, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
}
