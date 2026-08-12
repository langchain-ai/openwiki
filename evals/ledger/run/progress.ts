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

/** Optional rendering controls for CLI progress output. */
export interface CliProgressOptions {
  /** Print every stale and hallucinated claim beneath its checkpoint. */
  verbose?: boolean;
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
 * Format completed work as a clamped whole-number percentage.
 *
 * @param completed - Completed item count.
 * @param total - Total item count.
 *
 * @returns A percentage such as `49%`; empty work is already complete.
 */
export function formatProgressPercentage(
  completed: number,
  total: number,
): string {
  if (total <= 0) {
    return "100%";
  }

  const fraction = Math.min(1, Math.max(0, completed / total));
  return `${Math.round(fraction * 100)}%`;
}

/**
 * Render a metric fraction as a whole-number percentage for the compact live
 * checkpoint line.
 *
 * @param value - Fraction between zero and one.
 *
 * @returns Percentage text.
 */
function formatPercent(value: number | undefined): string {
  return formatPercentString(value, 0);
}

/** Format a populated sub-percent metric without rounding it down to zero. */
function formatMetricPercent(value: number, count: number): string {
  return count > 0 && value < 0.01 ? "<1%" : formatPercent(value);
}

/** Normalize one evaluator-produced claim to a stable terminal line. */
function formatClaimText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
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
  options: CliProgressOptions = {},
): BenchmarkProgressReporter {
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spinnerFrame = 0;
  let spinnerMessage: string | undefined;
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  let completedSystem:
    | {
        command: "init" | "update";
        durationMs: number;
        skipped: boolean;
      }
    | undefined;

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
   * Replace the text of the active activity once more detail is available.
   * Non-interactive logs retain both lifecycle messages as separate lines.
   *
   * @param message - Refined activity text.
   */
  function updateSpinner(message: string): void {
    if (spinnerMessage === undefined) {
      startSpinner(message);
      return;
    }

    spinnerMessage = message;
    renderSpinner();
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
        completedSystem = event;
        break;
      }
      case "artifact-captured": {
        if (event.loaded === true) {
          output.write(
            `│ 📚 Loaded ${event.documentCount} document${event.documentCount === 1 ? "" : "s"}\n`,
          );
        } else if (completedSystem !== undefined) {
          const status = completedSystem.skipped ? "skipped" : "complete";
          completeSpinner(
            `🤖 OpenWiki ${completedSystem.command} ${status} · ${formatProgressDuration(completedSystem.durationMs)} · ${event.documentCount} document${event.documentCount === 1 ? "" : "s"}`,
          );
          completedSystem = undefined;
        }
        break;
      }
      case "evaluation-start":
        startSpinner("🔍 Extracting claims");
        break;
      case "claim-extraction-progress":
        updateSpinner(
          `🔍 Extracting claims · ${formatProgressPercentage(event.completed, event.total)}`,
        );
        break;
      case "claim-evaluation-progress":
        updateSpinner(
          `🔍 Grounding ${event.claimCount} claim${event.claimCount === 1 ? "" : "s"} · ${formatProgressPercentage(event.completed, event.total)}`,
        );
        break;
      case "checkpoint-complete":
        completeSpinner(
          `📊 ${event.claimCount} claim${event.claimCount === 1 ? "" : "s"}`,
        );
        output.write(
          `│    supported ${formatMetricPercent(event.supportedRate, event.supportedCount)} (${event.supportedCount}) · stale ${formatMetricPercent(event.stalenessRate, event.staleCount)} (${event.staleCount}) · hallucinated ${formatMetricPercent(event.hallucinationRate, event.hallucinatedCount)} (${event.hallucinatedCount}) · unverified ${formatMetricPercent(event.unverifiedRate, event.unverifiedCount)} (${event.unverifiedCount})\n`,
        );
        if (options.verbose === true && event.staleClaims.length > 0) {
          output.write("│    ↳ stale\n");
          for (const claim of event.staleClaims) {
            output.write(
              `│       ${formatClaimText(claim.location)} · “${formatClaimText(claim.assertion)}”\n`,
            );
          }
        }
        if (options.verbose === true && event.hallucinatedClaims.length > 0) {
          output.write("│    ↳ hallucinated\n");
          for (const claim of event.hallucinatedClaims) {
            output.write(
              `│       ${formatClaimText(claim.location)} · “${formatClaimText(claim.assertion)}”\n`,
            );
          }
        }
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
