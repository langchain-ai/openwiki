import { formatPercent as formatPercentString } from "./format.js";
import type { BenchmarkProgressReporter } from "./progress-events.js";

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
 * Render a score fraction as a whole-number percentage for the compact live
 * checkpoint line.
 *
 * @param score - Score between zero and one.
 *
 * @returns Percentage text.
 */
function formatPercent(score: number | undefined): string {
  return formatPercentString(score, 0);
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
 * Create the framed, line-oriented progress reporter used by the LEDGER CLI.
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
        const systemModel = event.systemModelId ?? "provider default";
        const evaluatorModel = event.evaluatorModelId ?? "provider default";
        output.write(
          `┌ 🧪 LEDGER · ${event.benchmarkName} · ${event.difficulty}\n`,
        );
        output.write(
          event.evaluationOnly === true
            ? `│ ${event.totalCheckpoints} checkpoints · ${event.provider} · saved artifacts · evaluator ${evaluatorModel}\n`
            : `│ ${event.totalCheckpoints} checkpoints · ${event.provider} · system ${systemModel} · evaluator ${evaluatorModel}\n`,
        );
        break;
      }
      case "replay-ready":
        output.write(
          event.saved === true
            ? "│ ♻️ Saved artifacts and source evidence ready\n"
            : "│ 📦 Replay workspace ready\n",
        );
        break;
      case "checkpoint-start": {
        const position = `${event.checkpointIndex + 1}/${event.totalCheckpoints}`;
        const label = event.label ? ` · ${event.label}` : "";
        output.write("│\n");
        output.write(
          `├ 📍 ${position} · ${event.checkpointId} · ${event.commit.slice(0, 7)}${label}\n`,
        );
        if (event.evaluationOnly !== true) {
          startSpinner(`🤖 Running OpenWiki ${event.command}`);
        }
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
          `│ 📚 ${event.loaded === true ? "Loaded" : "Captured"} ${event.documentCount} document${event.documentCount === 1 ? "" : "s"}\n`,
        );
        break;
      case "evaluation-start":
        startSpinner(
          `🔍 Evaluating ${event.surfaceItemCount} surface items · ${event.obsoleteFactCount} obsolete versions`,
        );
        break;
      case "checkpoint-complete":
        completeSpinner(
          `✅ ${event.checkpointId} · coverage ${formatPercent(event.coverageScore)} · precision ${formatPercent(event.precisionScore)} · hallucination ${formatPercent(event.hallucinationRate)} · forgetting ${formatForgetting(event.forgottenCount, event.obsoleteFactCount)}`,
        );
        if (event.indeterminateCount > 0) {
          output.write(
            `│    ↳ ⚠️ evaluator ${formatPercent(event.evaluationCompleteness)} complete · ${event.indeterminateCount}/${event.evaluationItemCount} indeterminate\n`,
          );
        }
        break;
      case "run-complete":
        // The framed footer is rendered from the full run result by
        // `formatRunSummary`, which the CLI prints after the run so it can name
        // the worst checkpoints and point at the persisted unverified-claims
        // file. Here we only retire the live spinner.
        clearSpinner();
        break;
      case "run-failed":
        clearSpinner();
        output.write("│\n");
        output.write(`└ ❌ Failed · ${formatFailure(event.message)}\n\n`);
        break;
    }
  };
}
