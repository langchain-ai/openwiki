// Deterministic authoring script for the `taskflow` LEDGER benchmark.
//
// Rebuilds the choreographed git history into `repo.bundle` next to this file,
// with pinned author/committer identity and dates so the checkpoint commit SHAs
// are reproducible across machines. Run it with `node build-repo.mjs`; it prints
// the checkpoint SHAs to fold into `benchmark.json`.
//
// This slice covers T0 (taskflow 0.1.0) through T1 (taskflow 0.2.0) only. Later
// checkpoints are appended as the benchmark grows.
//
// Safety: every git call uses execFileSync with an explicit argument array and
// no shell; all writes land inside a fresh os.tmpdir workspace or this benchmark
// directory; the embedded library sources are static text, never evaluated.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
    env: { ...process.env, ...IDENTITY, ...extraEnv },
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  }).trim();
}

// ---------------------------------------------------------------------------
// Embedded source snapshots. Kept free of backticks and template-literal
// interpolation so they can live inside these template literals verbatim.
// ---------------------------------------------------------------------------

const TASK_TS = `/**
 * The lifecycle states a task moves through inside taskflow.
 */
export type TaskState = "pending" | "running" | "succeeded" | "failed";

/**
 * A unit of asynchronous work managed by a Queue and executed by a worker pool.
 */
export interface Task<T = unknown> {
  /** Stable identifier assigned when the task is created. */
  readonly id: string;

  /** The asynchronous work performed when the task runs. */
  run: () => Promise<T>;

  /** Current lifecycle state; a new task starts as "pending". */
  state: TaskState;
}

let counter = 0;

/**
 * Wrap an asynchronous function in a pending task.
 *
 * @param run - The work to perform when the task is executed.
 * @returns A task in the "pending" state.
 */
export function createTask<T>(run: () => Promise<T>): Task<T> {
  counter += 1;
  return { id: "task-" + counter, run, state: "pending" };
}
`;

const ERRORS_FULL = `/**
 * Base class for every error thrown by taskflow.
 */
export class TaskflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Thrown when a task is dequeued from an empty queue.
 */
export class QueueEmptyError extends TaskflowError {
  constructor() {
    super("Cannot dequeue from an empty queue.");
  }
}

/**
 * Thrown when the work backing a task rejects during execution.
 */
export class TaskFailedError extends TaskflowError {
  readonly taskId: string;
  readonly cause: unknown;

  constructor(taskId: string, cause: unknown) {
    super("Task " + taskId + " failed.");
    this.taskId = taskId;
    this.cause = cause;
  }
}
`;

const ERRORS_NO_EMPTY = `/**
 * Base class for every error thrown by taskflow.
 */
export class TaskflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Thrown when the work backing a task rejects during execution.
 */
export class TaskFailedError extends TaskflowError {
  readonly taskId: string;
  readonly cause: unknown;

  constructor(taskId: string, cause: unknown) {
    super("Task " + taskId + " failed.");
    this.taskId = taskId;
    this.cause = cause;
  }
}
`;

const QUEUE_FIFO = `import { QueueEmptyError } from "./errors.js";
import type { Task } from "./task.js";

/**
 * An in-memory queue of pending tasks.
 *
 * Tasks are dequeued in first-in, first-out order. The queue holds tasks in
 * memory only and performs no persistence or I/O.
 */
export class Queue {
  private readonly tasks: Task[] = [];

  /**
   * Add a task to the back of the queue.
   *
   * @param task - The task to enqueue.
   */
  enqueue(task: Task): void {
    this.tasks.push(task);
  }

  /**
   * Remove and return the task at the front of the queue.
   *
   * @returns The next task to run.
   * @throws QueueEmptyError when the queue holds no tasks.
   */
  dequeue(): Task {
    const task = this.tasks.shift();
    if (task === undefined) {
      throw new QueueEmptyError();
    }
    return task;
  }

  /**
   * Return the next task without removing it.
   *
   * @returns The task at the front of the queue, or undefined when empty.
   */
  peek(): Task | undefined {
    return this.tasks[0];
  }

  /**
   * The number of tasks currently queued.
   */
  get size(): number {
    return this.tasks.length;
  }

  /**
   * Remove all pending tasks from the queue.
   */
  clear(): void {
    this.tasks.length = 0;
  }
}
`;

const QUEUE_PRIORITY = `import { QueueEmptyError } from "./errors.js";
import type { Task } from "./task.js";

interface QueueEntry {
  task: Task;
  priority: number;
  sequence: number;
}

/**
 * An in-memory priority queue of pending tasks.
 *
 * Tasks are dequeued in priority order, highest first, with ties broken in
 * first-in, first-out order. The queue holds tasks in memory only and performs
 * no persistence or I/O.
 */
export class Queue {
  private readonly entries: QueueEntry[] = [];
  private sequence = 0;

  /**
   * Add a task to the queue.
   *
   * @param task - The task to enqueue.
   * @param priority - Higher values are dequeued sooner. Defaults to 0.
   */
  enqueue(task: Task, priority = 0): void {
    this.sequence += 1;
    this.entries.push({ task, priority, sequence: this.sequence });
  }

  /**
   * Remove and return the highest-priority task.
   *
   * @returns The next task to run.
   * @throws QueueEmptyError when the queue holds no tasks.
   */
  dequeue(): Task {
    const index = this.nextIndex();
    if (index === undefined) {
      throw new QueueEmptyError();
    }
    return this.entries.splice(index, 1)[0].task;
  }

  /**
   * Return the highest-priority task without removing it.
   *
   * @returns The next task to run, or undefined when empty.
   */
  peek(): Task | undefined {
    const index = this.nextIndex();
    return index === undefined ? undefined : this.entries[index].task;
  }

  /**
   * The number of tasks currently queued.
   */
  get size(): number {
    return this.entries.length;
  }

  /**
   * Remove all pending tasks from the queue.
   */
  clear(): void {
    this.entries.length = 0;
  }

  private nextIndex(): number | undefined {
    if (this.entries.length === 0) {
      return undefined;
    }
    let best = 0;
    for (let i = 1; i < this.entries.length; i += 1) {
      const candidate = this.entries[i];
      const incumbent = this.entries[best];
      if (
        candidate.priority > incumbent.priority ||
        (candidate.priority === incumbent.priority &&
          candidate.sequence < incumbent.sequence)
      ) {
        best = i;
      }
    }
    return best;
  }
}
`;

const QUEUE_PRIORITY_UNDEFINED = `import type { Task } from "./task.js";

interface QueueEntry {
  task: Task;
  priority: number;
  sequence: number;
}

/**
 * An in-memory priority queue of pending tasks.
 *
 * Tasks are dequeued in priority order, highest first, with ties broken in
 * first-in, first-out order. The queue holds tasks in memory only and performs
 * no persistence or I/O.
 */
export class Queue {
  private readonly entries: QueueEntry[] = [];
  private sequence = 0;

  /**
   * Add a task to the queue.
   *
   * @param task - The task to enqueue.
   * @param priority - Higher values are dequeued sooner. Defaults to 0.
   */
  enqueue(task: Task, priority = 0): void {
    this.sequence += 1;
    this.entries.push({ task, priority, sequence: this.sequence });
  }

  /**
   * Remove and return the highest-priority task.
   *
   * @returns The next task to run, or undefined when the queue is empty.
   */
  dequeue(): Task | undefined {
    const index = this.nextIndex();
    if (index === undefined) {
      return undefined;
    }
    return this.entries.splice(index, 1)[0].task;
  }

  /**
   * Return the highest-priority task without removing it.
   *
   * @returns The next task to run, or undefined when empty.
   */
  peek(): Task | undefined {
    const index = this.nextIndex();
    return index === undefined ? undefined : this.entries[index].task;
  }

  /**
   * The number of tasks currently queued.
   */
  get size(): number {
    return this.entries.length;
  }

  /**
   * Remove all pending tasks from the queue.
   */
  clear(): void {
    this.entries.length = 0;
  }

  private nextIndex(): number | undefined {
    if (this.entries.length === 0) {
      return undefined;
    }
    let best = 0;
    for (let i = 1; i < this.entries.length; i += 1) {
      const candidate = this.entries[i];
      const incumbent = this.entries[best];
      if (
        candidate.priority > incumbent.priority ||
        (candidate.priority === incumbent.priority &&
          candidate.sequence < incumbent.sequence)
      ) {
        best = i;
      }
    }
    return best;
  }
}
`;

const WORKER_SEQ_THROWS = `import { TaskFailedError } from "./errors.js";
import type { Queue } from "./queue.js";
import type { Task } from "./task.js";

/**
 * Drains a queue, running one task at a time to completion.
 */
export class WorkerPool {
  private readonly queue: Queue;

  constructor(queue: Queue) {
    this.queue = queue;
  }

  /**
   * Run queued tasks one at a time until the queue is empty.
   *
   * @throws TaskFailedError when a task's work rejects.
   */
  async run(): Promise<void> {
    while (this.queue.size > 0) {
      await this.execute(this.queue.dequeue());
    }
  }

  private async execute(task: Task): Promise<void> {
    task.state = "running";
    try {
      await task.run();
      task.state = "succeeded";
    } catch (cause) {
      task.state = "failed";
      throw new TaskFailedError(task.id, cause);
    }
  }
}
`;

const WORKER_SEQ_UNDEFINED = `import { TaskFailedError } from "./errors.js";
import type { Queue } from "./queue.js";
import type { Task } from "./task.js";

/**
 * Drains a queue, running one task at a time to completion.
 */
export class WorkerPool {
  private readonly queue: Queue;

  constructor(queue: Queue) {
    this.queue = queue;
  }

  /**
   * Run queued tasks one at a time until the queue is empty.
   *
   * @throws TaskFailedError when a task's work rejects.
   */
  async run(): Promise<void> {
    for (
      let task = this.queue.dequeue();
      task !== undefined;
      task = this.queue.dequeue()
    ) {
      await this.execute(task);
    }
  }

  private async execute(task: Task): Promise<void> {
    task.state = "running";
    try {
      await task.run();
      task.state = "succeeded";
    } catch (cause) {
      task.state = "failed";
      throw new TaskFailedError(task.id, cause);
    }
  }
}
`;

const WORKER_CONCURRENT = `import { TaskFailedError } from "./errors.js";
import type { Queue } from "./queue.js";
import type { Task } from "./task.js";

/**
 * Options controlling how a worker pool drains its queue.
 */
export interface WorkerPoolOptions {
  /**
   * Maximum number of tasks to run at the same time. Defaults to 1.
   */
  concurrency?: number;
}

/**
 * Drains a queue, running up to a configurable number of tasks concurrently.
 */
export class WorkerPool {
  private readonly queue: Queue;
  private readonly concurrency: number;

  constructor(queue: Queue, options: WorkerPoolOptions = {}) {
    this.queue = queue;
    this.concurrency = Math.max(1, options.concurrency ?? 1);
  }

  /**
   * Run queued tasks until the queue is empty, keeping up to the configured
   * concurrency of tasks running at once.
   *
   * @throws TaskFailedError when a task's work rejects.
   */
  async run(): Promise<void> {
    const workers: Array<Promise<void>> = [];
    for (let i = 0; i < this.concurrency; i += 1) {
      workers.push(this.drain());
    }
    await Promise.all(workers);
  }

  private async drain(): Promise<void> {
    for (
      let task = this.queue.dequeue();
      task !== undefined;
      task = this.queue.dequeue()
    ) {
      await this.execute(task);
    }
  }

  private async execute(task: Task): Promise<void> {
    task.state = "running";
    try {
      await task.run();
      task.state = "succeeded";
    } catch (cause) {
      task.state = "failed";
      throw new TaskFailedError(task.id, cause);
    }
  }
}
`;

const INDEX_FULL = `export { Queue } from "./queue.js";
export { WorkerPool } from "./worker.js";
export { createTask } from "./task.js";
export type { Task, TaskState } from "./task.js";
export { TaskflowError, QueueEmptyError, TaskFailedError } from "./errors.js";
`;

const INDEX_NO_EMPTY = `export { Queue } from "./queue.js";
export { WorkerPool } from "./worker.js";
export { createTask } from "./task.js";
export type { Task, TaskState } from "./task.js";
export { TaskflowError, TaskFailedError } from "./errors.js";
`;

const INDEX_CONCURRENCY = `export { Queue } from "./queue.js";
export { WorkerPool } from "./worker.js";
export type { WorkerPoolOptions } from "./worker.js";
export { createTask } from "./task.js";
export type { Task, TaskState } from "./task.js";
export { TaskflowError, TaskFailedError } from "./errors.js";
`;

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "declaration": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true
  },
  "include": ["src", "test"]
}
`;

const PRETTIERRC = `{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all"
}
`;

const PKG_010 = `{
  "name": "taskflow",
  "version": "0.1.0",
  "description": "A small in-memory task queue and worker pool for TypeScript.",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.4.0"
  },
  "license": "MIT"
}
`;

const PKG_010_PRETTIER = `{
  "name": "taskflow",
  "version": "0.1.0",
  "description": "A small in-memory task queue and worker pool for TypeScript.",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "format": "prettier --write ."
  },
  "devDependencies": {
    "prettier": "^3.2.5",
    "typescript": "^5.4.0",
    "vitest": "^1.4.0"
  },
  "license": "MIT"
}
`;

const PKG_020 = `{
  "name": "taskflow",
  "version": "0.2.0",
  "description": "A small in-memory task queue and worker pool for TypeScript.",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "format": "prettier --write ."
  },
  "devDependencies": {
    "prettier": "^3.2.5",
    "typescript": "^5.4.0",
    "vitest": "^1.4.0"
  },
  "license": "MIT"
}
`;

const TEST_T0 = `import { describe, expect, it } from "vitest";

import { QueueEmptyError } from "../src/errors.js";
import { Queue } from "../src/queue.js";
import { createTask } from "../src/task.js";

describe("Queue", () => {
  it("dequeues tasks in first-in, first-out order", () => {
    const queue = new Queue();
    const first = createTask(async () => 1);
    const second = createTask(async () => 2);
    queue.enqueue(first);
    queue.enqueue(second);
    expect(queue.dequeue()).toBe(first);
    expect(queue.dequeue()).toBe(second);
  });

  it("throws when dequeuing from an empty queue", () => {
    const queue = new Queue();
    expect(() => queue.dequeue()).toThrow(QueueEmptyError);
  });

  it("clears all pending tasks", () => {
    const queue = new Queue();
    queue.enqueue(createTask(async () => 1));
    queue.clear();
    expect(queue.size).toBe(0);
  });
});
`;

const TEST_PRIORITY = `import { describe, expect, it } from "vitest";

import { QueueEmptyError } from "../src/errors.js";
import { Queue } from "../src/queue.js";
import { createTask } from "../src/task.js";

describe("Queue", () => {
  it("dequeues tasks in first-in, first-out order", () => {
    const queue = new Queue();
    const first = createTask(async () => 1);
    const second = createTask(async () => 2);
    queue.enqueue(first);
    queue.enqueue(second);
    expect(queue.dequeue()).toBe(first);
    expect(queue.dequeue()).toBe(second);
  });

  it("dequeues higher-priority tasks first", () => {
    const queue = new Queue();
    const low = createTask(async () => 1);
    const high = createTask(async () => 2);
    queue.enqueue(low, 1);
    queue.enqueue(high, 5);
    expect(queue.dequeue()).toBe(high);
  });

  it("throws when dequeuing from an empty queue", () => {
    const queue = new Queue();
    expect(() => queue.dequeue()).toThrow(QueueEmptyError);
  });

  it("clears all pending tasks", () => {
    const queue = new Queue();
    queue.enqueue(createTask(async () => 1));
    queue.clear();
    expect(queue.size).toBe(0);
  });
});
`;

const TEST_FIX = `import { describe, expect, it } from "vitest";

import { Queue } from "../src/queue.js";
import { createTask } from "../src/task.js";

describe("Queue", () => {
  it("dequeues tasks in first-in, first-out order", () => {
    const queue = new Queue();
    const first = createTask(async () => 1);
    const second = createTask(async () => 2);
    queue.enqueue(first);
    queue.enqueue(second);
    expect(queue.dequeue()).toBe(first);
    expect(queue.dequeue()).toBe(second);
  });

  it("dequeues higher-priority tasks first", () => {
    const queue = new Queue();
    const low = createTask(async () => 1);
    const high = createTask(async () => 2);
    queue.enqueue(low, 1);
    queue.enqueue(high, 5);
    expect(queue.dequeue()).toBe(high);
  });

  it("returns undefined when dequeuing from an empty queue", () => {
    const queue = new Queue();
    expect(queue.dequeue()).toBeUndefined();
  });

  it("clears all pending tasks", () => {
    const queue = new Queue();
    queue.enqueue(createTask(async () => 1));
    queue.clear();
    expect(queue.size).toBe(0);
  });
});
`;

const README_T0 = `# taskflow

A small in-memory task queue and worker pool for TypeScript.

Current version: 0.1.0

taskflow lets you enqueue units of asynchronous work and drain them with a
worker pool. It keeps everything in memory and has no runtime dependencies.

## Installation

    npm install taskflow

## Getting started

    import { Queue, WorkerPool, createTask } from "taskflow";

    const queue = new Queue();
    queue.enqueue(createTask(async () => console.log("first")));
    queue.enqueue(createTask(async () => console.log("second")));

    await new WorkerPool(queue).run();

## Tasks

A task wraps an asynchronous function and tracks its lifecycle state, one of
pending, running, succeeded, or failed. Build one with createTask.

## Queue

Queue is an in-memory queue exposing enqueue, dequeue, peek, size, and clear.
Tasks are dequeued in first-in, first-out order. Calling dequeue on an empty
queue throws QueueEmptyError. Calling clear discards all pending tasks.

## Worker pool

WorkerPool drains a queue by running one task at a time to completion. If a
task's work rejects, the pool throws TaskFailedError carrying the failing task
id.

## Errors

Every error thrown by taskflow extends the TaskflowError base class.

## License

MIT
`;

const README_PRIORITY = `# taskflow

A small in-memory task queue and worker pool for TypeScript.

Current version: 0.1.0

taskflow lets you enqueue units of asynchronous work and drain them with a
worker pool. It keeps everything in memory and has no runtime dependencies.

## Installation

    npm install taskflow

## Getting started

    import { Queue, WorkerPool, createTask } from "taskflow";

    const queue = new Queue();
    queue.enqueue(createTask(async () => console.log("low")), 1);
    queue.enqueue(createTask(async () => console.log("high")), 5);

    await new WorkerPool(queue).run();

## Tasks

A task wraps an asynchronous function and tracks its lifecycle state, one of
pending, running, succeeded, or failed. Build one with createTask.

## Queue

Queue is an in-memory priority queue exposing enqueue, dequeue, peek, size, and
clear. enqueue accepts an optional priority (default 0); tasks are dequeued in
priority order, highest first, with ties broken in first-in, first-out order.
Calling dequeue on an empty queue throws QueueEmptyError. Calling clear discards
all pending tasks.

## Worker pool

WorkerPool drains a queue by running one task at a time to completion. If a
task's work rejects, the pool throws TaskFailedError carrying the failing task
id.

## Errors

Every error thrown by taskflow extends the TaskflowError base class.

## License

MIT
`;

const README_FIX = `# taskflow

A small in-memory task queue and worker pool for TypeScript.

Current version: 0.1.0

taskflow lets you enqueue units of asynchronous work and drain them with a
worker pool. It keeps everything in memory and has no runtime dependencies.

## Installation

    npm install taskflow

## Getting started

    import { Queue, WorkerPool, createTask } from "taskflow";

    const queue = new Queue();
    queue.enqueue(createTask(async () => console.log("low")), 1);
    queue.enqueue(createTask(async () => console.log("high")), 5);

    await new WorkerPool(queue).run();

## Tasks

A task wraps an asynchronous function and tracks its lifecycle state, one of
pending, running, succeeded, or failed. Build one with createTask.

## Queue

Queue is an in-memory priority queue exposing enqueue, dequeue, peek, size, and
clear. enqueue accepts an optional priority (default 0); tasks are dequeued in
priority order, highest first, with ties broken in first-in, first-out order.
Calling dequeue on an empty queue returns undefined. Calling clear discards all
pending tasks.

## Worker pool

WorkerPool drains a queue by running one task at a time to completion. If a
task's work rejects, the pool throws TaskFailedError carrying the failing task
id.

## Errors

Every error thrown by taskflow extends the TaskflowError base class.

## License

MIT
`;

const README_CONCURRENCY = `# taskflow

A small in-memory task queue and worker pool for TypeScript.

Current version: 0.1.0

taskflow lets you enqueue units of asynchronous work and drain them with a
worker pool. It keeps everything in memory and has no runtime dependencies.

## Installation

    npm install taskflow

## Getting started

    import { Queue, WorkerPool, createTask } from "taskflow";

    const queue = new Queue();
    queue.enqueue(createTask(async () => console.log("low")), 1);
    queue.enqueue(createTask(async () => console.log("high")), 5);

    await new WorkerPool(queue, { concurrency: 4 }).run();

## Tasks

A task wraps an asynchronous function and tracks its lifecycle state, one of
pending, running, succeeded, or failed. Build one with createTask.

## Queue

Queue is an in-memory priority queue exposing enqueue, dequeue, peek, size, and
clear. enqueue accepts an optional priority (default 0); tasks are dequeued in
priority order, highest first, with ties broken in first-in, first-out order.
Calling dequeue on an empty queue returns undefined. Calling clear discards all
pending tasks.

## Worker pool

WorkerPool drains a queue by running up to a configurable number of tasks
concurrently. Pass a concurrency option (default 1) to bound how many tasks run
in parallel. If a task's work rejects, the pool throws TaskFailedError carrying
the failing task id.

## Errors

Every error thrown by taskflow extends the TaskflowError base class.

## License

MIT
`;

const README_T1 = `# taskflow

A small in-memory task queue and worker pool for TypeScript.

Current version: 0.2.0

taskflow lets you enqueue units of asynchronous work and drain them with a
worker pool. It keeps everything in memory and has no runtime dependencies.

## Installation

    npm install taskflow

## Getting started

    import { Queue, WorkerPool, createTask } from "taskflow";

    const queue = new Queue();
    queue.enqueue(createTask(async () => console.log("low")), 1);
    queue.enqueue(createTask(async () => console.log("high")), 5);

    await new WorkerPool(queue, { concurrency: 4 }).run();

## Tasks

A task wraps an asynchronous function and tracks its lifecycle state, one of
pending, running, succeeded, or failed. Build one with createTask.

## Queue

Queue is an in-memory priority queue exposing enqueue, dequeue, peek, size, and
clear. enqueue accepts an optional priority (default 0); tasks are dequeued in
priority order, highest first, with ties broken in first-in, first-out order.
Calling dequeue on an empty queue returns undefined. Calling clear discards all
pending tasks.

## Worker pool

WorkerPool drains a queue by running up to a configurable number of tasks
concurrently. Pass a concurrency option (default 1) to bound how many tasks run
in parallel. If a task's work rejects, the pool throws TaskFailedError carrying
the failing task id.

## Errors

Every error thrown by taskflow extends the TaskflowError base class.

## Changelog

### 0.2.0

- Queue orders tasks by priority, breaking ties first-in, first-out.
- WorkerPool runs tasks concurrently via a configurable concurrency option.
- Queue.dequeue returns undefined on an empty queue instead of throwing.

### 0.1.0

- Initial release: FIFO queue, sequential worker pool, in-memory only.

## License

MIT
`;

// ---------------------------------------------------------------------------
// Commit choreography. Each step lists only the files it changes; unchanged
// files persist from the previous commit.
// ---------------------------------------------------------------------------

const steps = [
  {
    message:
      "feat: taskflow 0.1.0 MVP - FIFO queue, sequential worker, task lifecycle",
    date: "2024-01-08T09:00:00+0000",
    checkpoint: "T0",
    files: {
      "package.json": PKG_010,
      "tsconfig.json": TSCONFIG,
      "README.md": README_T0,
      "src/index.ts": INDEX_FULL,
      "src/task.ts": TASK_TS,
      "src/queue.ts": QUEUE_FIFO,
      "src/worker.ts": WORKER_SEQ_THROWS,
      "src/errors.ts": ERRORS_FULL,
      "test/queue.test.ts": TEST_T0,
    },
  },
  {
    message: "feat: order queued tasks by priority",
    date: "2024-01-12T09:00:00+0000",
    files: {
      "src/queue.ts": QUEUE_PRIORITY,
      "test/queue.test.ts": TEST_PRIORITY,
      "README.md": README_PRIORITY,
    },
  },
  {
    message: "fix: return undefined from dequeue on an empty queue",
    date: "2024-01-16T09:00:00+0000",
    files: {
      "src/queue.ts": QUEUE_PRIORITY_UNDEFINED,
      "src/worker.ts": WORKER_SEQ_UNDEFINED,
      "src/errors.ts": ERRORS_NO_EMPTY,
      "src/index.ts": INDEX_NO_EMPTY,
      "test/queue.test.ts": TEST_FIX,
      "README.md": README_FIX,
    },
  },
  {
    message: "feat: process tasks concurrently in the worker pool",
    date: "2024-01-19T09:00:00+0000",
    files: {
      "src/worker.ts": WORKER_CONCURRENT,
      "src/index.ts": INDEX_CONCURRENCY,
      "README.md": README_CONCURRENCY,
    },
  },
  {
    message: "chore: adopt prettier and add a format script",
    date: "2024-01-22T09:00:00+0000",
    files: {
      "package.json": PKG_010_PRETTIER,
      ".prettierrc.json": PRETTIERRC,
    },
  },
  {
    message: "release: taskflow 0.2.0",
    date: "2024-01-24T09:00:00+0000",
    checkpoint: "T1",
    files: {
      "package.json": PKG_020,
      "README.md": README_T1,
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

  process.stdout.write(JSON.stringify(shas, null, 2) + "\n");
} finally {
  rmSync(work, { recursive: true, force: true });
}
