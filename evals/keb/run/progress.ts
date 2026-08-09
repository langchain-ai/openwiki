import { performance } from "node:perf_hooks";

import type {
  BenchmarkProgressEvent,
  BenchmarkProgressReporter,
} from "./runner.js";

/**
 * Destination used for progress output.
 */
export interface ProgressOutput {
  /**
   * Whether the destination supports interactive cursor control.
   */
  isTTY?: boolean;

  /**
   * Write one complete progress line.
   *
   * @param text - Rendered line including its trailing newline.
   */
  write(text: string): void;
}

/**
 * Format milliseconds as a compact human-readable duration.
 *
 * @param durationMs - Non-negative elapsed milliseconds.
 *
 * @returns A compact duration such as `850ms`, `4.2s`, or `2m 3s`.
 */
export function formatProgressDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${Math.round(durationMs)}ms`;
  }

  if (durationMs < 60_000) {
    return `${(durationMs / 1_000).toFixed(1)}s`;
  }

  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Render a score fraction as a whole-number percentage.
 *
 * @param score - Score between zero and one.
 *
 * @returns Percentage text.
 */
function formatPercent(score: number): string {
  return `${(score * 100).toFixed(0)}%`;
}

/**
 * Render an aggregate metric with one decimal place or a dash when the trace
 * has no eligible transitions for that metric.
 *
 * @param score - Optional score between zero and one.
 *
 * @returns Percentage text or a dash.
 */
function formatAggregatePercent(score: number | undefined): string {
  return score === undefined ? "-" : `${(score * 100).toFixed(1)}%`;
}

/**
 * Format forgetting as unavailable or as a successful-removal rate and count.
 *
 * @param forgottenCount - Obsolete versions no longer presented as current.
 * @param obsoleteFactCount - Total obsolete versions evaluated.
 *
 * @returns Clear forgetting summary for one checkpoint.
 */
function formatForgetting(
  forgottenCount: number,
  obsoleteFactCount: number,
): string {
  if (obsoleteFactCount === 0) {
    return "-";
  }

  return `${formatPercent(forgottenCount / obsoleteFactCount)} (${forgottenCount}/${obsoleteFactCount})`;
}

/**
 * Reduce an error to one bounded terminal line.
 *
 * @param message - Raw failure message.
 *
 * @returns Whitespace-normalized bounded text.
 */
function formatFailure(message: string): string {
  return message.replace(/\s+/gu, " ").trim().slice(0, 300);
}

/**
 * Create the framed, line-oriented progress reporter used by the KEB CLI.
 * The reporter intentionally writes to stderr so stdout remains suitable for
 * report capture and shell pipelines.
 *
 * @param output - Destination for rendered progress lines.
 *
 * @returns A synchronous benchmark lifecycle reporter.
 */
export function createCliProgressReporter(
  output: ProgressOutput = process.stderr,
): BenchmarkProgressReporter {
  let startedAt = performance.now();
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spinnerFrame = 0;
  let spinnerMessage: string | undefined;
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * Render the current interactive spinner frame in place.
   */
  function renderSpinner(): void {
    if (spinnerMessage === undefined) {
      return;
    }

    output.write(
      `\r\u001B[2K│ ${spinnerFrames[spinnerFrame % spinnerFrames.length]} ${spinnerMessage}`,
    );
    spinnerFrame += 1;
  }

  /**
   * Start one long-running activity, animated only for interactive terminals.
   *
   * @param message - Activity text displayed beside the spinner.
   */
  function startSpinner(message: string): void {
    if (output.isTTY !== true) {
      output.write(`│ ${message}\n`);
      return;
    }

    spinnerMessage = message;
    spinnerFrame = 0;
    renderSpinner();
    spinnerTimer = setInterval(renderSpinner, 80);
    spinnerTimer.unref();
  }

  /**
   * Replace the active spinner with a permanent completed activity line.
   *
   * @param message - Final activity text.
   */
  function completeSpinner(message: string): void {
    if (spinnerTimer !== undefined) {
      clearInterval(spinnerTimer);
      spinnerTimer = undefined;
    }

    if (spinnerMessage !== undefined) {
      output.write(`\r\u001B[2K│ ${message}\n`);
      spinnerMessage = undefined;
      return;
    }

    output.write(`│ ${message}\n`);
  }

  /**
   * Clear an active spinner before rendering a terminal footer.
   */
  function clearSpinner(): void {
    if (spinnerTimer !== undefined) {
      clearInterval(spinnerTimer);
      spinnerTimer = undefined;
    }

    if (spinnerMessage !== undefined) {
      output.write("\r\u001B[2K");
      spinnerMessage = undefined;
    }
  }

  return (event): void => {
    switch (event.type) {
      case "run-start": {
        startedAt = performance.now();
        const systemModel = event.systemModelId ?? "provider default";
        const evaluatorModel = event.evaluatorModelId ?? "provider default";
        output.write(`┌ 🧪 KEB · ${event.benchmarkName}\n`);
        output.write(
          `│ ${event.totalCheckpoints} checkpoints · ${event.provider} · system ${systemModel} · evaluator ${evaluatorModel}\n`,
        );
        break;
      }
      case "replay-ready":
        output.write("│ 📦 Replay workspace ready\n");
        break;
      case "checkpoint-start": {
        const position = `${event.checkpointIndex + 1}/${event.totalCheckpoints}`;
        const label = event.label ? ` · ${event.label}` : "";
        output.write("│\n");
        output.write(
          `├ 📍 ${position} · ${event.checkpointId} · ${event.commit.slice(0, 7)}${label}\n`,
        );
        startSpinner(`🤖 Running OpenWiki ${event.command}`);
        break;
      }
      case "system-complete": {
        const status = event.skipped ? "skipped" : "complete";
        completeSpinner(
          `🤖 OpenWiki ${event.command} ${status} · ${formatProgressDuration(event.durationMs)}`,
        );
        break;
      }
      case "artifact-captured":
        output.write(
          `│ 📚 Captured ${event.documentCount} document${event.documentCount === 1 ? "" : "s"}\n`,
        );
        break;
      case "evaluation-start":
        startSpinner(
          `🔍 Evaluating ${event.activeFactCount} active facts · ${event.obsoleteFactCount} obsolete versions`,
        );
        break;
      case "checkpoint-complete":
        completeSpinner(
          `✅ ${event.checkpointId} · coverage ${formatPercent(event.coverageScore)} · precision ${formatPercent(event.precisionScore)} · forgetting ${formatForgetting(event.forgottenCount, event.obsoleteFactCount)}`,
        );
        break;
      case "run-complete":
        clearSpinner();
        output.write("│\n");
        output.write(`├ 📊 Quality ${formatAggregatePercent(event.quality)}\n`);
        output.write(
          `│  ├ Coverage ${formatAggregatePercent(event.traceCoverage)}\n`,
        );
        output.write(
          `│  └ Precision ${formatAggregatePercent(event.tracePrecision)}\n`,
        );
        output.write(
          `├ 🔄 Maintenance ${formatAggregatePercent(event.maintenance)}\n`,
        );
        output.write(
          `│  ├ Discovery ${formatAggregatePercent(event.newKnowledgeDiscovery)}\n`,
        );
        output.write(
          `│  ├ Correction ${formatAggregatePercent(event.changedKnowledgeCorrection)}\n`,
        );
        output.write(
          `│  ├ Forgetting ${formatAggregatePercent(event.completeForgetting)}\n`,
        );
        output.write(
          `│  └ Retention ${formatAggregatePercent(event.stableRetention)}\n`,
        );
        output.write("│\n");
        output.write(
          `└ 🎉 KEB ${formatAggregatePercent(event.kebScore)} · ${formatProgressDuration(performance.now() - startedAt)}\n\n`,
        );
        break;
      case "run-failed":
        clearSpinner();
        output.write("│\n");
        output.write(`└ ❌ Failed · ${formatFailure(event.message)}\n\n`);
        break;
    }
  };
}
