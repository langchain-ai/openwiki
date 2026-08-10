import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { EvaluationError } from "../core/errors.js";
import type {
  EvidenceCorpus,
  PrecisionAssertionEvaluation,
} from "../core/types.js";
import { invokeStructuredModel } from "./direct-model.js";
import type { ArtifactSection } from "./documents.js";
import {
  PRECISION_EXTRACTION_SYSTEM,
  PRECISION_JUDGMENT_SYSTEM,
  precisionExtractionPrompt,
  precisionJudgmentPrompt,
  type PrecisionEvidenceExcerpt,
  type PrecisionExtractionSection,
  type PrecisionJudgmentAssertion,
} from "./prompts.js";
import { SectionBm25Index } from "./retrieval.js";
import {
  assertionExtractionOutputSchema,
  precisionJudgmentOutputSchema,
  type AssertionExtractionOutput,
  type PrecisionJudgmentOutput,
} from "./schemas.js";

const DEFAULT_EXTRACTION_BATCH_SIZE = 4;
const DEFAULT_JUDGMENT_BATCH_SIZE = 20;
const DEFAULT_EVIDENCE_TOP_K = 8;
const EVIDENCE_FALLBACK_BATCH_SIZE = 8;

/**
 * One material assertion extracted from the artifact and assigned a stable,
 * code-owned identity before semantic judgment.
 */
export interface ExtractedArtifactAssertion {
  /**
   * Deterministic assertion identifier assigned in stable extraction order.
   */
  id: string;

  /**
   * Atomic assertion text returned by extraction.
   */
  statement: string;

  /**
   * Stable artifact section from which the assertion was extracted.
   */
  sectionId: string;

  /**
   * Wiki path owned by the source artifact section.
   */
  relativePath: string;
}

/**
 * Deterministic reason an assertion candidate or complete section was excluded
 * from the precision denominator.
 */
export type PrecisionExclusionReason =
  | "wiki-navigation-section"
  | "commit-history-section"
  | "wiki-meta-assertion"
  | "commit-history-assertion"
  | "repository-archaeology"
  | "editorial-assertion"
  | "prescriptive-assertion"
  | "hypothetical-assertion"
  | "exact-duplicate"
  | "semantic-duplicate";

/**
 * One complete artifact section excluded before model extraction.
 */
export interface ExcludedPrecisionSection {
  /**
   * Stable artifact section identifier.
   */
  sectionId: string;

  /**
   * Wiki path owning the section.
   */
  relativePath: string;

  /**
   * Active heading hierarchy used for deterministic classification.
   */
  headingPath: string[];

  /**
   * Code-owned exclusion reason.
   */
  reason: Extract<
    PrecisionExclusionReason,
    "wiki-navigation-section" | "commit-history-section"
  >;
}

/**
 * One model-extracted assertion candidate and its code-owned disposition.
 */
export interface PrecisionAssertionInventoryEntry {
  /**
   * Stable identity assigned before filtering.
   */
  candidateId: string;

  /**
   * Normalized assertion text.
   */
  statement: string;

  /**
   * Stable source section identifier.
   */
  sectionId: string;

  /**
   * Wiki path owning the source section.
   */
  relativePath: string;

  /**
   * Active heading hierarchy at the source section.
   */
  headingPath: string[];

  /**
   * Whether the candidate enters the precision denominator.
   */
  disposition: "kept" | "excluded";

  /**
   * Stable assertion identity when the candidate is kept.
   */
  assertionId?: string;

  /**
   * Code-owned reason when the candidate is excluded.
   */
  exclusionReason?: PrecisionExclusionReason;

  /**
   * Earlier assertion identity when deduplication excluded the candidate.
   */
  duplicateOf?: string;
}

/**
 * One high-overlap pair retained for manual semantic-duplicate review.
 */
export interface PrecisionNearDuplicatePair {
  /**
   * First retained assertion identity.
   */
  firstAssertionId: string;

  /**
   * Second retained assertion identity.
   */
  secondAssertionId: string;

  /**
   * Jaccard overlap across normalized content-word sets.
   */
  tokenOverlap: number;
}

/**
 * Complete auditable output of precision extraction before semantic judgment.
 */
export interface PrecisionAssertionInventory {
  /**
   * Checkpoint whose artifact was extracted.
   */
  checkpointId: string;

  /**
   * Total artifact sections before deterministic section filtering.
   */
  totalSectionCount: number;

  /**
   * Sections sent to assertion extraction.
   */
  extractedSectionCount: number;

  /**
   * Sections excluded before assertion extraction.
   */
  excludedSections: ExcludedPrecisionSection[];

  /**
   * Every extracted candidate, including excluded and duplicate candidates.
   */
  candidates: PrecisionAssertionInventoryEntry[];

  /**
   * Retained assertion count used as the precision denominator.
   */
  keptAssertionCount: number;

  /**
   * Lexically similar retained pairs for manual semantic-duplicate review.
   */
  nearDuplicatePairs: PrecisionNearDuplicatePair[];
}

/**
 * Inputs for exhaustive bounded precision evaluation.
 */
export interface PrecisionPassInput {
  /**
   * Evaluator model used for extraction and semantic judgment.
   */
  model: BaseChatModel;

  /**
   * Checkpoint being evaluated.
   */
  checkpointId: string;

  /**
   * Complete artifact section set.
   */
  sections: ArtifactSection[];

  /**
   * Normalized source evidence with explicit current and historical metadata.
   */
  evidence: EvidenceCorpus;

  /**
   * Number of complete sections supplied to each extraction request.
   *
   * @default 4
   */
  extractionBatchSize?: number;

  /**
   * Number of extracted assertions supplied to each judgment request.
   *
   * @default 20
   */
  judgmentBatchSize?: number;

  /**
   * Per-attempt evaluator request deadline in milliseconds.
   */
  timeoutMs?: number;

  /**
   * Optional audit sink invoked after extraction and deterministic filtering,
   * before any precision-judgment request.
   */
  onInventory?: (
    inventory: PrecisionAssertionInventory,
  ) => void | Promise<void>;
}

/**
 * Internal normalized assertion before code-owned filtering and identity.
 */
interface RawExtractedAssertion {
  /**
   * Normalized assertion text.
   */
  statement: string;

  /**
   * Stable source section identifier.
   */
  sectionId: string;

  /**
   * Wiki path owning the source section.
   */
  relativePath: string;

  /**
   * Active source heading hierarchy.
   */
  headingPath: string[];
}

/**
 * Compare strings using locale-independent code-unit ordering.
 *
 * @param a - First string.
 * @param b - Second string.
 *
 * @returns A negative number, zero, or a positive number for sorting.
 */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Split an ordered array into stable non-empty batches.
 *
 * @param values - Ordered values to batch.
 * @param size - Positive maximum batch size.
 *
 * @returns Stable batches preserving input order.
 */
function batch<T>(values: T[], size: number): T[][] {
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
function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new EvaluationError(`${name} must be a positive integer.`);
  }
}

/**
 * Normalize assertion whitespace without changing its factual content.
 *
 * @param statement - Raw extracted assertion.
 *
 * @returns Trimmed assertion with internal whitespace collapsed.
 */
function normalizeStatement(statement: string): string {
  return statement.replace(/\s+/g, " ").trim();
}

/**
 * Produce the exact-deduplication key used by Precision V1.
 *
 * @param statement - Whitespace-normalized assertion.
 *
 * @returns Assertion with terminal punctuation removed for exact comparison.
 */
function deduplicationKey(statement: string): string {
  return statement
    .toLowerCase()
    .replace(/[`'"“”‘’]/gu, "")
    .replace(/[^a-z0-9_+.-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/[.!?;:]+$/u, "")
    .trim();
}

/**
 * Recognize conservative families of equivalent repository-absence claims.
 * Generic lexical similarity is intentionally insufficient because it can
 * collapse distinct functions or numeric examples that share most tokens.
 *
 * @param statement - Whitespace-normalized assertion.
 *
 * @returns Stable semantic family key, or undefined when equivalence is not
 * safely recognizable.
 */
function semanticDeduplicationKey(statement: string): string | undefined {
  const normalized = statement
    .toLowerCase()
    .replace(/[`'"“”‘’]/gu, "")
    .replace(/[^a-z0-9*.+/-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const expressesAbsence =
    /\b(?:no|none|without|lacks?|absent)\b/u.test(normalized) ||
    /\b(?:does|do) not (?:contain|include|have|exist)\b/u.test(normalized);

  if (!expressesAbsence) {
    return undefined;
  }

  const families: Array<[string, RegExp]> = [
    ["test-command", /\b(?:npm )?test command\b/u],
    ["build-command", /\bbuild command\b/u],
    ["lint-command", /\blint command\b/u],
    [
      "typescript-config",
      /\b(?:tsconfig(?:.json)?|typescript (?:compiler )?config)/u,
    ],
    [
      "test-runner",
      /\b(?:test runner|test framework|test configuration|test config)\b/u,
    ],
    [
      "tests",
      /\b(?:focused tests?|test files?|test suite|tests? exist|tests? anywhere|test director)/u,
    ],
    [
      "package-manifest",
      /\b(?:package.json|package manifest|package tooling)\b/u,
    ],
    ["ci", /\b(?:ci|continuous integration|\.github\/workflows)\b/u],
    ["lint", /\b(?:eslint|lint configuration|lint tooling)\b/u],
    ["format", /\b(?:prettier|format configuration|format tooling)\b/u],
    ["build-output", /\b(?:dist\/|build output|build director)/u],
    [
      "build-tooling",
      /\b(?:build tooling|build configuration|bundler config)/u,
    ],
    ["dependencies", /\b(?:dependency list|dependencies)\b/u],
    ["barrel", /\b(?:barrel|index module|package entrypoint)\b/u],
    ["other-source-directories", /\b(?:other|additional) source director/u],
  ];

  return families.find(([, pattern]) => pattern.test(normalized))?.[0];
}

/**
 * Normalize heading text for deterministic section classification.
 *
 * @param heading - Raw Markdown heading text.
 *
 * @returns Lowercase alphanumeric words separated by single spaces.
 */
function normalizeHeading(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

/**
 * Identify complete sections that contain wiki routing rather than repository
 * knowledge, or narrate commit history rather than current state.
 *
 * @param section - Artifact section to classify.
 *
 * @returns A deterministic exclusion reason, or undefined when extractable.
 */
function sectionExclusionReason(
  section: ArtifactSection,
): ExcludedPrecisionSection["reason"] | undefined {
  const headings = section.headingPath.map(normalizeHeading);
  const navigationHeadings = [
    "documentation map",
    "source map",
    "where to look",
    "where to go next",
    "navigation",
    "page inventory",
    "related pages",
    "further reading",
  ];
  const historyHeadings = [
    "commit history",
    "change history",
    "git history",
    "evolution history",
  ];

  if (
    headings.some((heading) =>
      navigationHeadings.some(
        (candidate) =>
          heading === candidate || heading.startsWith(`${candidate} `),
      ),
    )
  ) {
    return "wiki-navigation-section";
  }

  if (
    headings.some((heading) =>
      historyHeadings.some(
        (candidate) =>
          heading === candidate || heading.startsWith(`${candidate} `),
      ),
    )
  ) {
    return "commit-history-section";
  }

  return undefined;
}

/**
 * Identify obvious non-current-state assertion candidates after extraction.
 *
 * @param statement - Normalized extracted assertion.
 *
 * @returns A deterministic exclusion reason, or undefined when retained.
 */
function assertionExclusionReason(
  statement: string,
):
  | Exclude<
      PrecisionExclusionReason,
      "wiki-navigation-section" | "commit-history-section" | "exact-duplicate"
    >
  | undefined {
  const normalized = statement.toLowerCase();

  if (
    /\b(?:this|the) (?:wiki )?page\b/u.test(normalized) ||
    /\b(?:wiki|documentation) (?:includes?|contains?|covers?|documents?)\b/u.test(
      normalized,
    ) ||
    /\b(?:overview|quickstart|api|versioning)\.md\b.+\b(?:documents?|explains?|describes?|covers?|entry point|navigation)\b/u.test(
      normalized,
    ) ||
    /\b(?:overview|quickstart|api|versioning) (?:document|page)\b/u.test(
      normalized,
    ) ||
    /\b(?:documented|covered) in the .+ (?:page|section)\b/u.test(normalized) ||
    /\b(?:relevant|recommended) page\b/u.test(normalized) ||
    /\bpage (?:is located|covers|provides a full reference)\b/u.test(
      normalized,
    ) ||
    /\b(?:see|refer to|go to|read) .+\b(?:page|section)\b/u.test(normalized)
  ) {
    return "wiki-meta-assertion";
  }

  if (
    /\bcommit\s+[0-9a-f]{7,40}\b/u.test(normalized) ||
    /\b[0-9a-f]{7,40}\b.+\b(?:commit|touched?|changed?|introduced|removed)\b/u.test(
      normalized,
    )
  ) {
    return "commit-history-assertion";
  }

  if (
    /\b(?:header|module[- ]level) comment\b/u.test(normalized) ||
    /\b(?:comment|docblock) (?:states?|describes?|reads?|says?)\b/u.test(
      normalized,
    ) ||
    /\b(?:exactly|only|single|total of)\s+(?:one|two|three|four|five|\d+)\s+(?:tracked\s+)?(?:source\s+)?files?\b/u.test(
      normalized,
    ) ||
    /\b(?:entire|complete) (?:repository|source|library).+\b(?:files?|entries)\b/u.test(
      normalized,
    ) ||
    /\brepository (?:root )?(?:contains?|has) no (?:package manifest|package\.json|tsconfig|test files?|test director|ci|build|lint|format)/u.test(
      normalized,
    ) ||
    /\bthere (?:is|are) no (?:package manifest|package\.json|tsconfig|test files?|test director|ci|build|lint|format)/u.test(
      normalized,
    ) ||
    /\bno (?:package manifest|package\.json|tsconfig|test runner|test configuration|build configuration|ci configuration|lint configuration|formatting configuration|npm scripts?)\b/u.test(
      normalized,
    ) ||
    /\b(?:no test files? exist|there are no tests?|no tests? anywhere)\b/u.test(
      normalized,
    ) ||
    /\b(?:nothing|no module).+\bimports?.*\bsrc\b/u.test(normalized) ||
    /\bno (?:internal or external )?consumers? (?:are )?checked into (?:this|the) repository\b/u.test(
      normalized,
    ) ||
    /\bleaf library with no .+consumers\b/u.test(normalized)
  ) {
    return "repository-archaeology";
  }

  if (
    /\bwell[- ]behaved\b/u.test(normalized) ||
    /\brather than (?:a )?production\b/u.test(normalized) ||
    /\bfor exercising (?:developer )?tooling\b/u.test(normalized)
  ) {
    return "editorial-assertion";
  }

  if (
    /\b(?:if|when) .+\b(?:were|was|is|are|changed?|added|removed|introduced)\b/u.test(
      normalized,
    ) ||
    /\b(?:would|could|might)\b/u.test(normalized) ||
    /\b(?:future|hypothetical|scenario)\b/u.test(normalized)
  ) {
    return "hypothetical-assertion";
  }

  if (
    /\b(?:contributors?|callers?|readers?|developers?|maintainers?|you)\b/u.test(
      normalized,
    ) &&
    /\b(?:should|must|needs? to|requires?|recommended|responsible for)\b/u.test(
      normalized,
    ) &&
    /\b(?:add|change|check|confirm|extend|keep|modify|preserve|read|run|update|validate|write)\w*\b/u.test(
      normalized,
    )
  ) {
    return "prescriptive-assertion";
  }

  return undefined;
}

/**
 * Tokenize an assertion for lexical near-duplicate measurement only.
 *
 * @param statement - Normalized assertion text.
 *
 * @returns Unique lowercase content tokens.
 */
function duplicateTokens(statement: string): Set<string> {
  const stopwords = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "in",
    "is",
    "of",
    "on",
    "or",
    "the",
    "to",
    "with",
  ]);

  return new Set(
    (statement.toLowerCase().match(/[a-z0-9_]+/gu) ?? []).filter(
      (token) => !stopwords.has(token),
    ),
  );
}

/**
 * Compute Jaccard overlap between two token sets.
 *
 * @param first - First token set.
 * @param second - Second token set.
 *
 * @returns Intersection size divided by union size.
 */
function tokenOverlap(first: Set<string>, second: Set<string>): number {
  const intersection = [...first].filter((token) => second.has(token)).length;
  const union = new Set([...first, ...second]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Convert an artifact section into the extraction prompt's data-only shape.
 *
 * @param section - Complete artifact section.
 *
 * @returns Serializable extraction section.
 */
function toExtractionSection(
  section: ArtifactSection,
): PrecisionExtractionSection {
  return {
    sectionId: section.id,
    relativePath: section.relativePath,
    headingPath: section.headingPath,
    content: section.content,
  };
}

/**
 * Validate and restore extraction output to the supplied section order.
 *
 * @param sections - Complete sections supplied to one extraction request.
 * @param output - Parsed extraction response.
 *
 * @returns One assertion array per section in request order.
 *
 * @throws EvaluationError for unknown, duplicate, missing, or empty assertions.
 */
function resolveExtraction(
  sections: ArtifactSection[],
  output: AssertionExtractionOutput,
): Array<{ section: ArtifactSection; assertions: string[] }> {
  const requested = new Set(sections.map((section) => section.id));
  const byId = new Map<string, AssertionExtractionOutput["sections"][number]>();

  for (const result of output.sections) {
    if (!requested.has(result.sectionId)) {
      throw new EvaluationError(
        `Precision extractor returned unknown sectionId "${result.sectionId}".`,
      );
    }

    if (byId.has(result.sectionId)) {
      throw new EvaluationError(
        `Precision extractor returned sectionId "${result.sectionId}" more than once.`,
      );
    }

    for (const assertion of result.assertions) {
      const normalized = normalizeStatement(assertion);

      if (deduplicationKey(normalized).length === 0) {
        throw new EvaluationError(
          `Precision extractor returned an assertion containing only punctuation for sectionId "${result.sectionId}".`,
        );
      }
    }

    byId.set(result.sectionId, result);
  }

  return sections.map((section) => {
    const result = byId.get(section.id);

    if (result === undefined) {
      throw new EvaluationError(
        `Precision extractor returned no result for sectionId "${section.id}".`,
      );
    }

    return { section, assertions: result.assertions };
  });
}

/**
 * Extract and normalize every model-proposed material artifact assertion while
 * visiting each supplied section exactly once.
 *
 * @param input - Precision pass configuration.
 * @param orderedSections - Complete sections in stable ID order.
 * @param extractionBatchSize - Validated extraction batch size.
 *
 * @returns Stable raw assertion candidates before code-owned filtering.
 */
async function extractAssertions(
  input: PrecisionPassInput,
  orderedSections: ArtifactSection[],
  extractionBatchSize: number,
): Promise<RawExtractedAssertion[]> {
  const extracted: RawExtractedAssertion[] = [];

  for (const sections of batch(orderedSections, extractionBatchSize)) {
    const output = await invokeStructuredModel({
      model: input.model,
      pass: "precision-extraction",
      checkpointId: input.checkpointId,
      systemPrompt: PRECISION_EXTRACTION_SYSTEM,
      taskPrompt: precisionExtractionPrompt(sections.map(toExtractionSection)),
      schema: assertionExtractionOutputSchema,
      validate: (parsed) => resolveExtraction(sections, parsed),
      timeoutMs: input.timeoutMs,
    });

    for (const result of resolveExtraction(sections, output)) {
      for (const rawStatement of result.assertions) {
        extracted.push({
          statement: normalizeStatement(rawStatement),
          sectionId: result.section.id,
          relativePath: result.section.relativePath,
          headingPath: result.section.headingPath,
        });
      }
    }
  }

  return extracted;
}

/**
 * Apply deterministic assertion exclusions, exact deduplication, stable IDs,
 * and near-duplicate measurement to raw extraction output.
 *
 * @param checkpointId - Checkpoint owning the artifact.
 * @param totalSectionCount - Complete section count before filtering.
 * @param extractedSectionCount - Sections sent to the model extractor.
 * @param excludedSections - Sections excluded before model extraction.
 * @param extracted - Raw normalized assertion candidates.
 *
 * @returns Auditable inventory plus retained precision assertions.
 */
function buildInventory(
  checkpointId: string,
  totalSectionCount: number,
  extractedSectionCount: number,
  excludedSections: ExcludedPrecisionSection[],
  extracted: RawExtractedAssertion[],
): {
  inventory: PrecisionAssertionInventory;
  assertions: ExtractedArtifactAssertion[];
} {
  const candidates: PrecisionAssertionInventoryEntry[] = [];
  const assertions: ExtractedArtifactAssertion[] = [];
  const assertionIdByDeduplicationKey = new Map<string, string>();
  const assertionIdBySemanticKey = new Map<string, string>();

  extracted.forEach((candidate, index) => {
    const candidateId = `candidate-${String(index + 1).padStart(6, "0")}`;
    const exclusionReason = assertionExclusionReason(candidate.statement);

    if (exclusionReason !== undefined) {
      candidates.push({
        candidateId,
        ...candidate,
        disposition: "excluded",
        exclusionReason,
      });
      return;
    }

    const key = deduplicationKey(candidate.statement);
    const duplicateOf = assertionIdByDeduplicationKey.get(key);

    if (duplicateOf !== undefined) {
      candidates.push({
        candidateId,
        ...candidate,
        disposition: "excluded",
        exclusionReason: "exact-duplicate",
        duplicateOf,
      });
      return;
    }

    const semanticKey = semanticDeduplicationKey(candidate.statement);
    const semanticDuplicateOf =
      semanticKey === undefined
        ? undefined
        : assertionIdBySemanticKey.get(semanticKey);

    if (semanticDuplicateOf !== undefined) {
      candidates.push({
        candidateId,
        ...candidate,
        disposition: "excluded",
        exclusionReason: "semantic-duplicate",
        duplicateOf: semanticDuplicateOf,
      });
      return;
    }

    const assertionId = `assertion-${String(assertions.length + 1).padStart(6, "0")}`;
    assertionIdByDeduplicationKey.set(key, assertionId);
    if (semanticKey !== undefined) {
      assertionIdBySemanticKey.set(semanticKey, assertionId);
    }
    assertions.push({ id: assertionId, ...candidate });
    candidates.push({
      candidateId,
      ...candidate,
      disposition: "kept",
      assertionId,
    });
  });

  const tokenSets = assertions.map((assertion) => ({
    assertion,
    tokens: duplicateTokens(assertion.statement),
  }));
  const nearDuplicatePairs: PrecisionNearDuplicatePair[] = [];

  for (let first = 0; first < tokenSets.length; first += 1) {
    for (let second = first + 1; second < tokenSets.length; second += 1) {
      if (
        tokenSets[first].tokens.size < 3 ||
        tokenSets[second].tokens.size < 3
      ) {
        continue;
      }

      const overlap = tokenOverlap(
        tokenSets[first].tokens,
        tokenSets[second].tokens,
      );

      if (overlap >= 0.75) {
        nearDuplicatePairs.push({
          firstAssertionId: tokenSets[first].assertion.id,
          secondAssertionId: tokenSets[second].assertion.id,
          tokenOverlap: Number(overlap.toFixed(3)),
        });
      }
    }
  }

  return {
    inventory: {
      checkpointId,
      totalSectionCount,
      extractedSectionCount,
      excludedSections,
      candidates,
      keptAssertionCount: assertions.length,
      nearDuplicatePairs,
    },
    assertions,
  };
}

/**
 * Artifact-section-compatible source evidence with explicit temporal context.
 */
interface EvidenceSection extends ArtifactSection {
  /**
   * Checkpoint at which the source content was observed.
   */
  observedAtCheckpoint: string;

  /**
   * Whether the source content belongs to the active checkpoint.
   */
  current: boolean;
}

/**
 * One artifact assertion paired with the exact source evidence visible to a
 * bounded semantic judgment.
 */
interface PrecisionJudgmentTarget {
  /**
   * Code-owned artifact assertion being judged.
   */
  assertion: ExtractedArtifactAssertion;

  /**
   * Source-evidence sections visible to this judgment.
   */
  evidence: EvidenceSection[];
}

/**
 * Convert internal precision targets into the prompt's data-only shape.
 *
 * @param targets - Assertions paired with their retrieved source evidence.
 *
 * @returns Serializable assertion targets.
 */
function toJudgmentAssertions(
  targets: PrecisionJudgmentTarget[],
): PrecisionJudgmentAssertion[] {
  return targets.map((target) => ({
    assertionId: target.assertion.id,
    statement: target.assertion.statement,
    evidenceIds: target.evidence.map((section) => section.id),
  }));
}

/**
 * Deduplicate evidence content across a judgment batch while preserving stable
 * first-seen order and assertion-specific allowed identities.
 *
 * @param targets - Assertion targets in request order.
 *
 * @returns Unique serialized source excerpts.
 */
function toJudgmentEvidence(
  targets: PrecisionJudgmentTarget[],
): PrecisionEvidenceExcerpt[] {
  const byId = new Map<string, PrecisionEvidenceExcerpt>();

  for (const target of targets) {
    for (const section of target.evidence) {
      if (!byId.has(section.id)) {
        byId.set(section.id, {
          evidenceId: section.id,
          sourceRef: section.relativePath,
          observedAtCheckpoint: section.observedAtCheckpoint,
          current: section.current,
          content: section.content,
        });
      }
    }
  }

  return [...byId.values()];
}

/**
 * Validate and resolve one precision-judgment response.
 *
 * @param targets - Assertions and evidence supplied to the classifier.
 * @param output - Parsed precision response.
 *
 * @returns External precision evaluations in assertion order.
 *
 * @throws EvaluationError for identity, completeness, or support-reference
 * violations.
 */
function resolveJudgments(
  targets: PrecisionJudgmentTarget[],
  output: PrecisionJudgmentOutput,
): PrecisionAssertionEvaluation[] {
  const requested = new Set(targets.map((target) => target.assertion.id));
  const byId = new Map<
    string,
    PrecisionJudgmentOutput["evaluations"][number]
  >();

  for (const evaluation of output.evaluations) {
    if (!requested.has(evaluation.assertionId)) {
      throw new EvaluationError(
        `Precision classifier returned unknown assertionId "${evaluation.assertionId}".`,
      );
    }

    if (byId.has(evaluation.assertionId)) {
      throw new EvaluationError(
        `Precision classifier returned assertionId "${evaluation.assertionId}" more than once.`,
      );
    }

    const target = targets.find(
      (candidate) => candidate.assertion.id === evaluation.assertionId,
    ) as PrecisionJudgmentTarget;
    const allowedEvidenceIds = new Set(
      target.evidence.map((evidence) => evidence.id),
    );
    const uniqueEvidenceIds = new Set(evaluation.evidenceIds);

    if (uniqueEvidenceIds.size !== evaluation.evidenceIds.length) {
      throw new EvaluationError(
        `Precision classifier returned duplicate evidence IDs for assertionId "${evaluation.assertionId}".`,
      );
    }

    for (const evidenceId of evaluation.evidenceIds) {
      if (!allowedEvidenceIds.has(evidenceId)) {
        throw new EvaluationError(
          `Precision classifier cited unavailable evidenceId "${evidenceId}" for assertionId "${evaluation.assertionId}".`,
        );
      }
    }

    if (
      evaluation.verdict !== "unverifiable" &&
      evaluation.evidenceIds.length === 0
    ) {
      throw new EvaluationError(
        `Precision classifier returned no evidence IDs for ${evaluation.verdict} assertionId "${evaluation.assertionId}".`,
      );
    }

    if (
      evaluation.verdict === "unverifiable" &&
      evaluation.evidenceIds.length > 0
    ) {
      throw new EvaluationError(
        `Precision classifier returned evidence IDs for unverifiable assertionId "${evaluation.assertionId}".`,
      );
    }

    byId.set(evaluation.assertionId, evaluation);
  }

  return targets.map((target) => {
    const evaluation = byId.get(target.assertion.id);

    if (evaluation === undefined) {
      throw new EvaluationError(
        `Precision classifier returned no verdict for assertionId "${target.assertion.id}".`,
      );
    }

    return {
      assertion: target.assertion.statement,
      location: target.assertion.relativePath,
      verdict: evaluation.verdict,
      evidenceIds: evaluation.evidenceIds,
      rationale: evaluation.rationale,
    };
  });
}

/**
 * Run exhaustive bounded assertion extraction and source-evidence judgment.
 *
 * @param input - Precision pass configuration.
 *
 * @returns One judgment per unique normalized artifact assertion.
 */
export async function runPrecisionPass(
  input: PrecisionPassInput,
): Promise<PrecisionAssertionEvaluation[]> {
  const extractionBatchSize =
    input.extractionBatchSize ?? DEFAULT_EXTRACTION_BATCH_SIZE;
  const judgmentBatchSize =
    input.judgmentBatchSize ?? DEFAULT_JUDGMENT_BATCH_SIZE;
  assertPositiveInteger(extractionBatchSize, "Precision extractionBatchSize");
  assertPositiveInteger(judgmentBatchSize, "Precision judgmentBatchSize");

  const orderedSections = [...input.sections].sort((a, b) =>
    compareStrings(a.id, b.id),
  );
  const sectionIds = new Set(orderedSections.map((section) => section.id));

  if (sectionIds.size !== orderedSections.length) {
    throw new EvaluationError(
      "Precision input contains duplicate artifact section IDs.",
    );
  }

  if (orderedSections.length === 0) {
    await input.onInventory?.({
      checkpointId: input.checkpointId,
      totalSectionCount: 0,
      extractedSectionCount: 0,
      excludedSections: [],
      candidates: [],
      keptAssertionCount: 0,
      nearDuplicatePairs: [],
    });
    return [];
  }

  const excludedSections: ExcludedPrecisionSection[] = [];
  const extractableSections = orderedSections.filter((section) => {
    const reason = sectionExclusionReason(section);

    if (reason === undefined) {
      return true;
    }

    excludedSections.push({
      sectionId: section.id,
      relativePath: section.relativePath,
      headingPath: section.headingPath,
      reason,
    });
    return false;
  });
  const extracted = await extractAssertions(
    input,
    extractableSections,
    extractionBatchSize,
  );
  const { inventory, assertions } = buildInventory(
    input.checkpointId,
    orderedSections.length,
    extractableSections.length,
    excludedSections,
    extracted,
  );
  await input.onInventory?.(inventory);

  if (assertions.length === 0) {
    return [];
  }

  const evidenceSections: EvidenceSection[] = input.evidence.records.map(
    (record, ordinal) => ({
      id: record.evidenceId,
      relativePath: record.sourceRef,
      observedAtCheckpoint: record.observedAtCheckpoint,
      current: record.current,
      headingPath: [],
      ordinal,
      content: record.content,
      searchableText: `${record.sourceRef}\n${record.content}`,
    }),
  );
  const evidenceIndex = new SectionBm25Index(evidenceSections);
  const initialTargets = assertions.map(
    (assertion): PrecisionJudgmentTarget => ({
      assertion,
      evidence: evidenceIndex
        .search(assertion.statement, DEFAULT_EVIDENCE_TOP_K)
        .map((ranked) => ranked.section as EvidenceSection),
    }),
  );
  const evaluationByAssertion = new Map<string, PrecisionAssertionEvaluation>();

  if (evidenceSections.length === 0) {
    return assertions.map((assertion) => ({
      assertion: assertion.statement,
      location: assertion.relativePath,
      verdict: "unverifiable",
      evidenceIds: [],
      rationale: "The checkpoint contains no source evidence.",
    }));
  }

  for (const targetBatch of batch(initialTargets, judgmentBatchSize)) {
    const output = await invokeStructuredModel({
      model: input.model,
      pass: "precision-judgment",
      checkpointId: input.checkpointId,
      systemPrompt: PRECISION_JUDGMENT_SYSTEM,
      taskPrompt: precisionJudgmentPrompt(
        toJudgmentAssertions(targetBatch),
        toJudgmentEvidence(targetBatch),
      ),
      schema: precisionJudgmentOutputSchema,
      validate: (parsed) => resolveJudgments(targetBatch, parsed),
      timeoutMs: input.timeoutMs,
    });

    for (const evaluation of resolveJudgments(targetBatch, output)) {
      const target = targetBatch.find(
        (candidate) => candidate.assertion.statement === evaluation.assertion,
      ) as PrecisionJudgmentTarget;
      evaluationByAssertion.set(target.assertion.id, evaluation);
    }
  }

  for (const target of initialTargets) {
    const initial = evaluationByAssertion.get(target.assertion.id);

    if (initial?.verdict !== "unverifiable") {
      continue;
    }

    const examined = new Set(target.evidence.map((evidence) => evidence.id));
    const remaining = evidenceIndex
      .sections()
      .filter((evidence) => !examined.has(evidence.id)) as EvidenceSection[];

    for (const evidence of batch(remaining, EVIDENCE_FALLBACK_BATCH_SIZE)) {
      const fallbackTarget = { assertion: target.assertion, evidence };
      const output = await invokeStructuredModel({
        model: input.model,
        pass: "precision-judgment",
        checkpointId: input.checkpointId,
        systemPrompt: PRECISION_JUDGMENT_SYSTEM,
        taskPrompt: precisionJudgmentPrompt(
          toJudgmentAssertions([fallbackTarget]),
          toJudgmentEvidence([fallbackTarget]),
        ),
        schema: precisionJudgmentOutputSchema,
        validate: (parsed) => resolveJudgments([fallbackTarget], parsed),
        timeoutMs: input.timeoutMs,
      });
      const [evaluation] = resolveJudgments([fallbackTarget], output);
      evaluationByAssertion.set(target.assertion.id, evaluation);

      if (evaluation.verdict !== "unverifiable") {
        break;
      }
    }
  }

  return assertions.map(
    (assertion) =>
      evaluationByAssertion.get(assertion.id) as PrecisionAssertionEvaluation,
  );
}
