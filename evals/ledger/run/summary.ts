import type { LedgerRunResult } from "../core/types.js";
import { formatPercent1 as pct } from "./format.js";
import { forgettingRate } from "./forgetting-rate.js";
import { formatProgressDuration } from "./progress.js";

/**
 * Options controlling the optional footer blocks that depend on state the run
 * result alone does not carry.
 */
export interface RunSummaryOptions {
  /**
   * Absolute path to the persisted unverified-claims worklist, when the run had
   * any unverified claims and the CLI wrote the file.
   *
   * @default undefined suppresses the Coverage-gaps block entirely
   */
  unverifiedClaimsPath?: string;

  /**
   * Wall-clock milliseconds the whole run took, stamped by the CLI (scripts read
   * no clock, so the elapsed time is injected here).
   *
   * @default undefined omits the elapsed time from the closing line
   */
  elapsedMs?: number;
}

/**
 * One checkpoint dimension that scored worse than every other across the trace,
 * surfaced so a reader knows where the run was weakest.
 */
export interface WeakestPoint {
  /**
   * The checkpoint the weakest dimension belongs to.
   */
  checkpointId: string;

  /**
   * The dimension label, one of `coverage`, `precision`, or `forgetting`.
   */
  dimension: string;

  /**
   * The dimension's fractional score, 0 to 1.
   */
  value: number;
}

/**
 * One concrete defect a reader should inspect, drawn from the per-checkpoint
 * verdicts and ranked by severity so the worst appear first.
 */
export interface Offender {
  /**
   * The checkpoint the defect was found at.
   */
  checkpointId: string;

  /**
   * Zero-based trace position of the checkpoint, used only as a stable tie-break.
   */
  checkpointIndex: number;

  /**
   * Severity rank; lower is worse. Fixed order: invented, contradicted, stale,
   * missing.
   */
  severity: number;

  /**
   * Human-readable defect class, for example `invented` or `missing`.
   */
  className: string;

  /**
   * Short description: the offending assertion for a precision defect, or the
   * requirement id for a coverage defect.
   */
  text: string;
}

/**
 * Fixed severity ranks for the worst-offender ranking. Lower is worse, and the
 * order is deliberate: an invented claim is the most damaging defect, a missing
 * requirement the least.
 */
const SEVERITY = { invented: 0, contradicted: 1, stale: 2, missing: 3 };

/**
 * Truncate a claim to a bounded single-line excerpt for the worst-offender list.
 *
 * @param text - The raw claim or identifier.
 *
 * @returns The text collapsed to one line and capped with an ellipsis.
 */
function excerpt(text: string): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length <= 60 ? collapsed : `${collapsed.slice(0, 59)}…`;
}

/**
 * Find the single lowest-scoring checkpoint dimension across the trace. Coverage,
 * precision, and forgetting are each considered per checkpoint; the running
 * minimum uses a strict comparison, so on ties the earliest checkpoint and the
 * earliest dimension in a fixed order win, keeping the choice deterministic.
 *
 * @param result - The complete run result.
 *
 * @returns The weakest dimension, or undefined when no dimension was scorable.
 */
export function selectWeakestPoint(
  result: LedgerRunResult,
): WeakestPoint | undefined {
  let weakest: WeakestPoint | undefined;

  const consider = (candidate: WeakestPoint): void => {
    if (weakest === undefined || candidate.value < weakest.value) {
      weakest = candidate;
    }
  };

  result.checkpoints.forEach((checkpoint) => {
    consider({
      checkpointId: checkpoint.checkpointId,
      dimension: "coverage",
      value: checkpoint.coverage.score,
    });

    if (checkpoint.precision.score !== undefined) {
      consider({
        checkpointId: checkpoint.checkpointId,
        dimension: "precision",
        value: checkpoint.precision.score,
      });
    }

    const forgetting = forgettingRate(
      checkpoint.evaluations?.forgettingEvaluations,
    );
    if (forgetting !== undefined) {
      consider({
        checkpointId: checkpoint.checkpointId,
        dimension: "forgetting",
        value: forgetting.rate,
      });
    }
  });

  return weakest;
}

/**
 * Rank the concrete defects across the trace worst-first and return the top few.
 * Invented and stale claims come from the precision verdicts; contradicted and
 * missing requirements come from the coverage verdicts. Ties break by severity,
 * then earliest checkpoint, then the defect text, so the ranking is a
 * deterministic function of the verdicts.
 *
 * @param result - The complete run result.
 * @param limit - The maximum number of offenders to return.
 *
 * @returns Up to `limit` offenders, worst first.
 */
export function selectWorstOffenders(
  result: LedgerRunResult,
  limit: number,
): Offender[] {
  const offenders: Offender[] = [];

  result.checkpoints.forEach((checkpoint, index) => {
    const detail = checkpoint.evaluations;
    if (detail === undefined) {
      return;
    }

    for (const claim of detail.precisionEvaluations) {
      if (claim.verdict === "invented" || claim.verdict === "stale") {
        offenders.push({
          checkpointId: checkpoint.checkpointId,
          checkpointIndex: index,
          severity: SEVERITY[claim.verdict],
          className: claim.verdict,
          text: `"${excerpt(claim.assertion)}"`,
        });
      }
    }

    for (const fact of detail.factEvaluations) {
      if (fact.verdict === "contradicted" || fact.verdict === "missing") {
        offenders.push({
          checkpointId: checkpoint.checkpointId,
          checkpointIndex: index,
          severity: SEVERITY[fact.verdict],
          className: fact.verdict,
          text: fact.factId,
        });
      }
    }
  });

  offenders.sort(
    (a, b) =>
      a.severity - b.severity ||
      a.checkpointIndex - b.checkpointIndex ||
      a.text.localeCompare(b.text),
  );

  return offenders.slice(0, limit);
}

/**
 * Render the stale-knowledge lifetime line, naming any versions still lingering
 * unresolved at the end of the trace.
 *
 * @param result - The complete run result.
 *
 * @returns The lifetime summary text.
 */
function lifetimeLine(result: LedgerRunResult): string {
  const stale = result.diagnostics.staleKnowledge;
  if (stale.meanResolvedLifetime === undefined) {
    return "stale-knowledge lifetime · no obsolete knowledge was ever forgotten";
  }

  const lifetime = `stale-knowledge lifetime ${stale.meanResolvedLifetime.toFixed(1)} checkpoints`;
  return stale.unresolvedCount === 0
    ? lifetime
    : `${lifetime} · ${stale.unresolvedCount} still stale at trace end`;
}

/**
 * Render the recovery line from the eligible and recovered counts.
 *
 * @param result - The complete run result.
 *
 * @returns The recovery summary text.
 */
function recoveryLine(result: LedgerRunResult): string {
  const { recovered, eligible } = result.diagnostics.recovery;
  return eligible === 0
    ? "recovery · no maintenance regressions to recover"
    : `recovery ${recovered} of ${eligible} regressions recovered later`;
}

/**
 * Render the final framed footer for a completed run. This is the concise summary
 * the CLI prints after the per-checkpoint stream: the headline score and its four
 * metrics, a coverage sparkline over the trace, the longitudinal diagnostics, a
 * ranked list of concrete defects to inspect, and a pointer to the unverified
 * claims worklist. Pure and deterministic given the result and options, so it is
 * exercised directly in tests without driving the live reporter.
 *
 * @param result - The completed run result.
 * @param options - Optional footer inputs the result does not itself carry.
 *
 * @returns The framed footer text, ending with a blank line.
 */
export function formatRunSummary(
  result: LedgerRunResult,
  options: RunSummaryOptions = {},
): string {
  const { score } = result;
  const lines: string[] = [];
  const push = (text: string): void => {
    lines.push(text);
  };

  const maintenance =
    score.maintenance === undefined
      ? ""
      : ` · maintenance ${pct(score.maintenance)}`;

  push("│");
  push(`├ 📊 quality ${pct(score.quality)}${maintenance}`);
  push(`│  ├ coverage ${pct(score.traceCoverage)}`);
  push(`│  ├ precision ${pct(score.tracePrecision)}`);
  push(`│  ├ hallucination ${pct(score.traceHallucinationRate)}`);
  push(`│  └ forgetting ${pct(score.maintenanceRates.completeForgetting)}`);

  push("│");
  push("├ ⏳ Over time");
  push(`│  ├ ${lifetimeLine(result)}`);
  push(`│  ├ ${recoveryLine(result)}`);
  const weakest = selectWeakestPoint(result);
  push(
    weakest === undefined
      ? "│  └ weakest point · not scorable"
      : `│  └ weakest point ${weakest.checkpointId} · ${weakest.dimension} ${pct(weakest.value)}`,
  );

  const offenders = selectWorstOffenders(result, 3);
  if (offenders.length > 0) {
    push("│");
    push("├ 🎯 Go look at");
    offenders.forEach((offender, index) => {
      const branch = index === offenders.length - 1 ? "└" : "├";
      push(
        `│  ${branch} ${offender.checkpointId} · ${offender.className} ${offender.text}`,
      );
    });
  }

  if (options.unverifiedClaimsPath !== undefined) {
    const unverified = result.checkpoints.reduce(
      (total, checkpoint) => total + checkpoint.precision.unverified,
      0,
    );
    push("│");
    push("├ 🔬 Unverified claims");
    push(
      `│  └ ${unverified} claim${unverified === 1 ? "" : "s"} the source evidence neither confirmed nor refuted → ${options.unverifiedClaimsPath}`,
    );
    push("│     review them for hidden hallucinations or missing evidence");
  }

  push("│");
  const icon = score.evaluationCompleteness === 1 ? "🎉" : "⚠️";
  const elapsed =
    options.elapsedMs === undefined
      ? ""
      : ` · ${formatProgressDuration(options.elapsedMs)}`;
  push(`└ ${icon} LEDGER ${pct(score.ledgerScore)}${elapsed}`);

  return `${lines.join("\n")}\n\n`;
}
