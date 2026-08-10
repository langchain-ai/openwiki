import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { EvaluationError } from "../core/errors.js";
import type {
  ActiveTruthFact,
  EvidenceCorpus,
  EvaluationWarning,
  PrecisionAssertionEvaluation,
} from "../core/types.js";
import { invokeStructuredModel } from "./direct-model.js";
import type { ArtifactSection } from "./documents.js";
import {
  PRECISION_EXTRACTION_SYSTEM,
  PRECISION_JUDGMENT_SYSTEM,
  PRECISION_LEDGER_SYSTEM,
  precisionExtractionPrompt,
  precisionJudgmentPrompt,
  precisionLedgerPrompt,
  type PrecisionEvidenceExcerpt,
  type PrecisionExtractionUnit,
  type PrecisionJudgmentAssertion,
  type PrecisionLedgerFact,
} from "./prompts.js";
import { SectionBm25Index } from "./retrieval.js";
import {
  assertionExtractionOutputSchema,
  precisionJudgmentOutputSchema,
  precisionLedgerOutputSchema,
  type AssertionExtractionOutput,
  type PrecisionJudgmentOutput,
  type PrecisionLedgerOutput,
} from "./schemas.js";

const DEFAULT_EXTRACTION_BATCH_SIZE = 20;
const DEFAULT_JUDGMENT_BATCH_SIZE = 20;
const DEFAULT_EVIDENCE_TOP_K = 8;
const EVIDENCE_FALLBACK_BATCH_SIZE = 8;
const MAX_EVIDENCE_DOSSIER_CHARS = 60_000;

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
 * Semantic role assigned to one complete code-owned artifact text unit.
 */
export type PrecisionTextUnitClassification =
  "factual" | "mixed" | "navigation" | "opinion" | "instruction" | "no-claim";

/**
 * Auditable classification of one artifact text unit before truth judgment.
 */
export interface PrecisionTextUnitInventoryEntry {
  /**
   * Stable code-owned text-unit identity.
   */
  unitId: string;

  /**
   * Stable artifact section owning the unit.
   */
  sectionId: string;

  /**
   * Wiki path owning the unit.
   */
  relativePath: string;

  /**
   * Active heading hierarchy at the unit.
   */
  headingPath: string[];

  /**
   * Exact Markdown block classified by the evaluator.
   */
  content: string;

  /**
   * Evaluator-assigned semantic role.
   */
  classification: PrecisionTextUnitClassification;

  /**
   * Factual assertions retained from factual or mixed units.
   */
  assertions: string[];

  /**
   * Concise explanation of the classification.
   */
  rationale: string;
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
   * Every code-owned text unit and its accountable semantic classification.
   */
  units: PrecisionTextUnitInventoryEntry[];

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
   * Human-authored material requirements active at this checkpoint.
   */
  activeFacts: ActiveTruthFact[];

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

  /**
   * Optional sink for items that remain invalid after isolated repair.
   */
  onWarning?: (warning: EvaluationWarning) => void;
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
  const normalized = statement
    .toLowerCase()
    .replace(/[`*_]/gu, "")
    .replace(/[“”‘’]/gu, "'");

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
    /\b(?:library|api) reference (?:documents?|covers?)\b/u.test(normalized) ||
    /\b(?:wiki )?quickstart\b.+\b(?:maps?|routes?|documents?|covers?)\b/u.test(
      normalized,
    ) ||
    /\bdocumented on (?:the )?.+\bpage\b/u.test(normalized) ||
    /\b(?:calc-api|versioning)\.md page\b/u.test(normalized) ||
    /\b(?:wiki|quickstart|reference)\b.+\b(?:entry point|navigation map|serves as)\b/u.test(
      normalized,
    ) ||
    /\b(?:documented|covered) in the .+ (?:page|section)\b/u.test(normalized) ||
    /\brecorded as .+\bsection\b/u.test(normalized) ||
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
    ) ||
    /\b(?:same|single) commit\b/u.test(normalized) ||
    /\bcommit\b.+\b(?:titled|named|message)\b/u.test(normalized) ||
    /\b(?:introduced|changed|removed) in (?:a|the) commit\b/u.test(normalized)
  ) {
    return "commit-history-assertion";
  }

  if (
    /\b(?:header|module[- ]level) (?:comment|docstring)\b/u.test(normalized) ||
    /\b(?:comment|docblock|docstring) (?:states?|describes?|reads?|says?)\b/u.test(
      normalized,
    ) ||
    /\bper (?:the )?(?:module )?docstring\b/u.test(normalized) ||
    /\b(?:exactly|only|single|total of)\s+(?:one|two|three|four|five|\d+)\s+(?:tracked\s+)?(?:source\s+)?files?\b/u.test(
      normalized,
    ) ||
    /\b(?:entire|complete) (?:tracked )?(?:repository|source|library).+\b(?:files?|entries|contents)\b/u.test(
      normalized,
    ) ||
    /\bgit ls-files\b/u.test(normalized)
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
    /^(?:extension )?step \d+\b/u.test(normalized) ||
    /\b(?:minimal|narrowest|only) (?:manual )?validation\b/u.test(normalized) ||
    /\bcan be validated with (?:a )?manual\b/u.test(normalized) ||
    /\badding a new .+\binvolves\b/u.test(normalized) ||
    (/\b(?:consumers?|contributors?|callers?|readers?|developers?|maintainers?|you)\b/u.test(
      normalized,
    ) &&
      /\b(?:should|must|needs? to|requires?|recommended|responsible for)\b/u.test(
        normalized,
      ) &&
      /\b(?:add|change|check|confirm|extend|keep|modify|preserve|read|run|update|validate|write)\w*\b/u.test(
        normalized,
      ))
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
 * Internal code-owned Markdown block before semantic classification.
 */
type PrecisionTextUnit = PrecisionExtractionUnit;

/**
 * Classifier output restored to its code-owned text unit.
 */
interface ClassifiedPrecisionTextUnit extends PrecisionTextUnit {
  /**
   * Semantic role assigned by the evaluator.
   */
  classification: PrecisionTextUnitClassification;

  /**
   * Normalized factual claims extracted from the unit.
   */
  assertions: string[];

  /**
   * Concise classification rationale.
   */
  rationale: string;
}

/**
 * Divide one artifact section into stable Markdown blocks. Blank lines split
 * units outside fenced code, while fenced content remains intact.
 *
 * @param section - Artifact section to divide.
 *
 * @returns Code-owned text units in exact source order.
 */
function textUnitsForSection(section: ArtifactSection): PrecisionTextUnit[] {
  const lines = section.content.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const blocks: string[] = [];
  let current = "";
  let fence: { marker: "`" | "~"; length: number } | undefined;

  /**
   * Persist one non-empty accumulated Markdown block.
   */
  function flush(): void {
    if (current.length === 0) {
      return;
    }

    blocks.push(current);
    current = "";
  }

  for (const line of lines) {
    const withoutNewline = line.replace(/\r?\n$/u, "");
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(withoutNewline)?.[1];

    if (fence === undefined && marker !== undefined) {
      fence = {
        marker: marker[0] as "`" | "~",
        length: marker.length,
      };
    } else if (
      fence !== undefined &&
      marker !== undefined &&
      marker[0] === fence.marker &&
      marker.length >= fence.length &&
      /^ {0,3}(?:`{3,}|~{3,})[\t ]*$/u.test(withoutNewline)
    ) {
      fence = undefined;
    }

    if (fence === undefined && withoutNewline.trim().length === 0) {
      flush();
      continue;
    }

    current += line;
  }

  flush();

  if (blocks.length === 0) {
    blocks.push("");
  }

  return blocks.map((content, index) => ({
    unitId: `${section.id}::unit-${String(index).padStart(4, "0")}`,
    sectionId: section.id,
    relativePath: section.relativePath,
    headingPath: section.headingPath,
    content,
  }));
}

/**
 * Validate and restore extraction output to the supplied text-unit order.
 *
 * @param units - Complete code-owned units supplied to one request.
 * @param output - Parsed classification response.
 *
 * @returns Classified units in request order.
 *
 * @throws EvaluationError for unknown, duplicate, missing, or internally
 * inconsistent unit results.
 */
function resolveExtraction(
  units: PrecisionTextUnit[],
  output: AssertionExtractionOutput,
): ClassifiedPrecisionTextUnit[] {
  const requested = new Set(units.map((unit) => unit.unitId));
  const byId = new Map<string, AssertionExtractionOutput["units"][number]>();

  for (const result of output.units) {
    if (!requested.has(result.unitId)) {
      throw new EvaluationError(
        `Precision extractor returned unknown unitId "${result.unitId}".`,
      );
    }

    if (byId.has(result.unitId)) {
      throw new EvaluationError(
        `Precision extractor returned unitId "${result.unitId}" more than once.`,
      );
    }

    const requiresAssertions =
      result.classification === "factual" || result.classification === "mixed";

    if (requiresAssertions !== result.assertions.length > 0) {
      throw new EvaluationError(
        `Precision extractor returned classification "${result.classification}" with ${result.assertions.length} assertions for unitId "${result.unitId}".`,
      );
    }

    for (const assertion of result.assertions) {
      const normalized = normalizeStatement(assertion);

      if (deduplicationKey(normalized).length === 0) {
        throw new EvaluationError(
          `Precision extractor returned an assertion containing only punctuation for unitId "${result.unitId}".`,
        );
      }
    }

    byId.set(result.unitId, result);
  }

  return units.map((unit) => {
    const result = byId.get(unit.unitId);

    if (result === undefined) {
      throw new EvaluationError(
        `Precision extractor returned no result for unitId "${unit.unitId}".`,
      );
    }

    return {
      ...unit,
      classification: result.classification,
      assertions: result.assertions.map(normalizeStatement),
      rationale: result.rationale,
    };
  });
}

/**
 * Classify every code-owned text unit and extract normalized factual assertions.
 *
 * @param input - Precision pass configuration.
 * @param orderedSections - Complete extractable sections in stable ID order.
 * @param extractionBatchSize - Validated text-unit batch size.
 *
 * @returns Classified unit inventory plus raw factual assertion candidates.
 */
async function extractAssertions(
  input: PrecisionPassInput,
  orderedSections: ArtifactSection[],
  extractionBatchSize: number,
): Promise<{
  units: PrecisionTextUnitInventoryEntry[];
  assertions: RawExtractedAssertion[];
}> {
  const units = orderedSections.flatMap(textUnitsForSection);
  const classified: ClassifiedPrecisionTextUnit[] = [];

  for (const unitBatch of batch(units, extractionBatchSize)) {
    const output = await invokeStructuredModel({
      model: input.model,
      pass: "precision-extraction",
      checkpointId: input.checkpointId,
      systemPrompt: PRECISION_EXTRACTION_SYSTEM,
      taskPrompt: precisionExtractionPrompt(unitBatch),
      schema: assertionExtractionOutputSchema,
      validate: (parsed) => resolveExtraction(unitBatch, parsed),
      timeoutMs: input.timeoutMs,
    });

    classified.push(...resolveExtraction(unitBatch, output));
  }

  return {
    units: classified.map((unit) => ({
      unitId: unit.unitId,
      sectionId: unit.sectionId,
      relativePath: unit.relativePath,
      headingPath: unit.headingPath,
      content: unit.content,
      classification: unit.classification,
      assertions: unit.assertions,
      rationale: unit.rationale,
    })),
    assertions: classified.flatMap((unit) =>
      unit.assertions.map((statement) => ({
        statement,
        sectionId: unit.sectionId,
        relativePath: unit.relativePath,
        headingPath: unit.headingPath,
      })),
    ),
  };
}

/**
 * Apply deterministic assertion exclusions, exact deduplication, stable IDs,
 * and near-duplicate measurement to raw extraction output.
 *
 * @param checkpointId - Checkpoint owning the artifact.
 * @param totalSectionCount - Complete section count before filtering.
 * @param extractedSectionCount - Sections sent to the model extractor.
 * @param excludedSections - Sections excluded before model extraction.
 * @param units - Complete classified text-unit inventory.
 * @param extracted - Raw normalized assertion candidates.
 *
 * @returns Auditable inventory plus retained precision assertions.
 */
function buildInventory(
  checkpointId: string,
  totalSectionCount: number,
  extractedSectionCount: number,
  excludedSections: ExcludedPrecisionSection[],
  units: PrecisionTextUnitInventoryEntry[],
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
      units,
      candidates,
      keptAssertionCount: assertions.length,
      nearDuplicatePairs,
    },
    assertions,
  };
}

/**
 * Internal result of accounting one artifact assertion against required
 * benchmark knowledge.
 */
interface LedgerAssertionEvaluation {
  /**
   * Code-owned assertion identity.
   */
  assertionId: string;

  /**
   * Relationship between the assertion and active requirements.
   */
  verdict: "supported" | "contradicted" | "unaccounted" | "indeterminate";

  /**
   * Active requirement-version identities establishing the verdict.
   */
  factVersionIds: string[];

  /**
   * One-sentence accounting rationale.
   */
  rationale: string;
}

/**
 * Convert active requirements into the stable prompt representation used for
 * ledger accounting.
 *
 * @param facts - Active material requirements.
 *
 * @returns Serializable requirement facts in benchmark order.
 */
function toLedgerFacts(facts: ActiveTruthFact[]): PrecisionLedgerFact[] {
  return facts.map((fact) => ({
    factId: fact.factId,
    factVersionId: fact.factVersionId,
    statement: fact.statement,
  }));
}

/**
 * Resolve and validate one assertion from a schema-valid ledger response.
 *
 * @param assertion - Code-owned artifact assertion.
 * @param output - Schema-valid batch response.
 * @param allowedFactVersionIds - Complete active requirement-version allowlist.
 *
 * @returns One validated ledger accounting result.
 *
 * @throws EvaluationError when the assertion result is missing, duplicated, or
 * cites an unavailable requirement version.
 */
function resolveLedgerItem(
  assertion: ExtractedArtifactAssertion,
  output: PrecisionLedgerOutput,
  allowedFactVersionIds: Set<string>,
): LedgerAssertionEvaluation {
  const matches = output.evaluations.filter(
    (evaluation) => evaluation.assertionId === assertion.id,
  );

  if (matches.length !== 1) {
    throw new EvaluationError(
      `Precision ledger classifier returned ${matches.length} verdicts for assertionId "${assertion.id}".`,
    );
  }

  const [evaluation] = matches;
  const uniqueFactVersionIds = new Set(evaluation.factVersionIds);

  if (uniqueFactVersionIds.size !== evaluation.factVersionIds.length) {
    throw new EvaluationError(
      `Precision ledger classifier returned duplicate factVersionIds for assertionId "${assertion.id}".`,
    );
  }

  for (const factVersionId of evaluation.factVersionIds) {
    if (!allowedFactVersionIds.has(factVersionId)) {
      throw new EvaluationError(
        `Precision ledger classifier cited unavailable factVersionId "${factVersionId}" for assertionId "${assertion.id}".`,
      );
    }
  }

  if (
    evaluation.verdict !== "unaccounted" &&
    evaluation.factVersionIds.length === 0
  ) {
    throw new EvaluationError(
      `Precision ledger classifier returned no factVersionIds for ${evaluation.verdict} assertionId "${assertion.id}".`,
    );
  }

  if (
    evaluation.verdict === "unaccounted" &&
    evaluation.factVersionIds.length > 0
  ) {
    throw new EvaluationError(
      `Precision ledger classifier returned factVersionIds for unaccounted assertionId "${assertion.id}".`,
    );
  }

  return {
    assertionId: assertion.id,
    verdict: evaluation.verdict,
    factVersionIds: evaluation.factVersionIds,
    rationale: evaluation.rationale,
  };
}

/**
 * Run one strict isolated ledger-accounting request for repair.
 *
 * @param input - Precision pass configuration.
 * @param assertion - Assertion whose batch result was malformed.
 * @param facts - Complete active requirement set.
 *
 * @returns One validated ledger accounting result.
 */
async function repairLedgerItem(
  input: PrecisionPassInput,
  assertion: ExtractedArtifactAssertion,
  facts: PrecisionLedgerFact[],
): Promise<LedgerAssertionEvaluation> {
  const allowedFactVersionIds = new Set(
    facts.map((fact) => fact.factVersionId),
  );
  const output = await invokeStructuredModel({
    model: input.model,
    pass: "precision-ledger",
    checkpointId: input.checkpointId,
    systemPrompt: PRECISION_LEDGER_SYSTEM,
    taskPrompt: precisionLedgerPrompt(
      [{ assertionId: assertion.id, statement: assertion.statement }],
      facts,
    ),
    schema: precisionLedgerOutputSchema,
    validate: (parsed) =>
      resolveLedgerItem(assertion, parsed, allowedFactVersionIds),
    timeoutMs: input.timeoutMs,
  });

  return resolveLedgerItem(assertion, output, allowedFactVersionIds);
}

/**
 * Account every extracted assertion against the complete active requirement
 * ledger. Valid neighbors survive malformed batch items; an irreparable item is
 * marked indeterminate rather than aborting the checkpoint.
 *
 * @param input - Precision pass configuration and warning sink.
 * @param assertions - Complete retained assertion inventory.
 *
 * @returns One ledger result per assertion in stable order.
 */
async function runLedgerAccounting(
  input: PrecisionPassInput,
  assertions: ExtractedArtifactAssertion[],
): Promise<LedgerAssertionEvaluation[]> {
  const facts = toLedgerFacts(input.activeFacts);

  if (facts.length === 0) {
    return assertions.map((assertion) => ({
      assertionId: assertion.id,
      verdict: "unaccounted",
      factVersionIds: [],
      rationale: "No active requirements were supplied for ledger accounting.",
    }));
  }

  const allowedFactVersionIds = new Set(
    facts.map((fact) => fact.factVersionId),
  );
  const results: LedgerAssertionEvaluation[] = [];

  for (const assertionBatch of batch(
    assertions,
    input.judgmentBatchSize ?? DEFAULT_JUDGMENT_BATCH_SIZE,
  )) {
    const output = await invokeStructuredModel({
      model: input.model,
      pass: "precision-ledger",
      checkpointId: input.checkpointId,
      systemPrompt: PRECISION_LEDGER_SYSTEM,
      taskPrompt: precisionLedgerPrompt(
        assertionBatch.map((assertion) => ({
          assertionId: assertion.id,
          statement: assertion.statement,
        })),
        facts,
      ),
      schema: precisionLedgerOutputSchema,
      timeoutMs: input.timeoutMs,
    });

    for (const assertion of assertionBatch) {
      try {
        results.push(
          resolveLedgerItem(assertion, output, allowedFactVersionIds),
        );
      } catch (initialError) {
        try {
          results.push(await repairLedgerItem(input, assertion, facts));
        } catch (repairError) {
          const initialMessage =
            initialError instanceof Error
              ? initialError.message
              : String(initialError);
          const repairMessage =
            repairError instanceof Error
              ? repairError.message
              : String(repairError);
          const message = `${initialMessage} Isolated repair failed: ${repairMessage}`;
          input.onWarning?.({
            pass: "precision-ledger",
            itemId: assertion.id,
            message,
          });
          results.push({
            assertionId: assertion.id,
            verdict: "indeterminate",
            factVersionIds: [],
            rationale: `Evaluator could not repair this ledger judgment: ${message}`,
          });
        }
      }
    }
  }

  return results;
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
 * Determine whether an adapter record explicitly claims to enumerate a complete
 * closed-world inventory.
 *
 * @param evidence - Normalized evidence section.
 *
 * @returns Whether the record should accompany every source judgment.
 */
function isCompleteInventory(evidence: EvidenceSection): boolean {
  return (
    evidence.id === "git:tracked-files" ||
    /\bcomplete\b[^\n]*\binventory\b/iu.test(evidence.content)
  );
}

/**
 * Build one bounded cumulative evidence dossier. Newly examined evidence and
 * complete inventories take precedence; prior evidence is retained while the
 * deterministic character budget permits.
 *
 * @param prior - Evidence already examined for the assertion.
 * @param additions - Newly examined evidence.
 * @param inventories - Complete inventory records relevant to every assertion.
 *
 * @returns Stable deduplicated evidence bounded by the dossier character cap.
 */
function evidenceDossier(
  prior: EvidenceSection[],
  additions: EvidenceSection[],
  inventories: EvidenceSection[],
): EvidenceSection[] {
  const ordered = [...inventories, ...additions, ...prior];
  const selected: EvidenceSection[] = [];
  const seen = new Set<string>();
  let characters = 0;

  for (const evidence of ordered) {
    if (seen.has(evidence.id)) {
      continue;
    }

    const nextCharacters = characters + evidence.content.length;

    if (selected.length > 0 && nextCharacters > MAX_EVIDENCE_DOSSIER_CHARS) {
      continue;
    }

    selected.push(evidence);
    seen.add(evidence.id);
    characters = nextCharacters;
  }

  return selected;
}

/**
 * Make a judgment batch's deduplicated evidence visibility explicit. The prompt
 * serializes one shared evidence array for the whole batch, so every assertion
 * can actually inspect every excerpt in that array. Giving each target that same
 * stable union keeps prompt metadata and citation validation aligned with the
 * model's real visibility.
 *
 * @param targets - Assertion targets whose evidence will share one prompt.
 *
 * @returns New targets that each reference the batch's stable evidence union.
 */
function shareBatchEvidence(
  targets: PrecisionJudgmentTarget[],
): PrecisionJudgmentTarget[] {
  const evidenceById = new Map<string, EvidenceSection>();

  for (const target of targets) {
    for (const evidence of target.evidence) {
      if (!evidenceById.has(evidence.id)) {
        evidenceById.set(evidence.id, evidence);
      }
    }
  }

  const sharedEvidence = [...evidenceById.values()];
  return targets.map((target) => ({
    assertion: target.assertion,
    evidence: sharedEvidence,
  }));
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
 * first-seen order.
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
    const normalizedRationale = evaluation.rationale.toLowerCase();

    if (
      evaluation.verdict === "contradicted" &&
      (/\b(?:seems|appears|is|should be) supported\b/u.test(
        normalizedRationale,
      ) ||
        /\bnot contradicted\b/u.test(normalizedRationale) ||
        /\bre-evaluat\w*\b.+\bsupported\b/u.test(normalizedRationale))
    ) {
      throw new EvaluationError(
        `Precision classifier rationale conflicts with contradicted verdict for assertionId "${evaluation.assertionId}".`,
      );
    }

    if (
      evaluation.verdict === "supported" &&
      (/\b(?:cannot|does not|doesn't|fails to) (?:verify|establish|support)\b/u.test(
        normalizedRationale,
      ) ||
        /\bnot supported\b/u.test(normalizedRationale))
    ) {
      throw new EvaluationError(
        `Precision classifier rationale conflicts with supported verdict for assertionId "${evaluation.assertionId}".`,
      );
    }
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
      evaluation.verdict !== "not-supported" &&
      evaluation.evidenceIds.length === 0
    ) {
      throw new EvaluationError(
        `Precision classifier returned no evidence IDs for ${evaluation.verdict} assertionId "${evaluation.assertionId}".`,
      );
    }

    if (
      evaluation.verdict === "not-supported" &&
      evaluation.evidenceIds.length > 0
    ) {
      throw new EvaluationError(
        `Precision classifier returned evidence IDs for not-supported assertionId "${evaluation.assertionId}".`,
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
      verdict: evaluation.verdict === "supported" ? "supported" : "unsupported",
      unsupportedReason:
        evaluation.verdict === "supported"
          ? undefined
          : evaluation.verdict === "contradicted"
            ? "contradicted"
            : "not-established",
      verificationSource: "source",
      evidenceIds: evaluation.evidenceIds,
      rationale: evaluation.rationale,
    };
  });
}

/**
 * Resolve one assertion from a possibly imperfect batch response. Extra or
 * malformed neighboring entries do not invalidate this item.
 *
 * @param target - Assertion and exact evidence visible to it.
 * @param output - Schema-valid batch response.
 *
 * @returns One validated precision evaluation.
 *
 * @throws EvaluationError when this assertion is missing, duplicated, has an
 * invalid evidence shape, or cites unavailable evidence.
 */
function resolveJudgmentItem(
  target: PrecisionJudgmentTarget,
  output: PrecisionJudgmentOutput,
): PrecisionAssertionEvaluation {
  const matching = output.evaluations.filter(
    (evaluation) => evaluation.assertionId === target.assertion.id,
  );

  return resolveJudgments([target], { evaluations: matching })[0];
}

/**
 * Run one strict isolated precision judgment. The direct evaluator retries the
 * request twice and rejects if either structured shape or semantic validation
 * remains invalid.
 *
 * @param input - Precision pass configuration.
 * @param target - One assertion and its visible evidence.
 *
 * @returns A validated precision evaluation.
 */
async function repairPrecisionJudgment(
  input: PrecisionPassInput,
  target: PrecisionJudgmentTarget,
): Promise<PrecisionAssertionEvaluation> {
  const output = await invokeStructuredModel({
    model: input.model,
    pass: "precision-judgment",
    checkpointId: input.checkpointId,
    systemPrompt: PRECISION_JUDGMENT_SYSTEM,
    taskPrompt: precisionJudgmentPrompt(
      toJudgmentAssertions([target]),
      toJudgmentEvidence([target]),
    ),
    schema: precisionJudgmentOutputSchema,
    validate: (parsed) => resolveJudgments([target], parsed),
    timeoutMs: input.timeoutMs,
  });

  return resolveJudgments([target], output)[0];
}

/**
 * Resolve a schema-valid precision batch item by item. Invalid items receive one
 * isolated two-attempt repair request; irreparable items become indeterminate
 * while valid neighbors survive unchanged.
 *
 * @param input - Precision pass configuration and warning sink.
 * @param targets - Assertions sharing one bounded evidence set.
 *
 * @returns One valid or indeterminate evaluation per target.
 */
async function resolvePrecisionBatchResilient(
  input: PrecisionPassInput,
  targets: PrecisionJudgmentTarget[],
): Promise<PrecisionAssertionEvaluation[]> {
  const output = await invokeStructuredModel({
    model: input.model,
    pass: "precision-judgment",
    checkpointId: input.checkpointId,
    systemPrompt: PRECISION_JUDGMENT_SYSTEM,
    taskPrompt: precisionJudgmentPrompt(
      toJudgmentAssertions(targets),
      toJudgmentEvidence(targets),
    ),
    schema: precisionJudgmentOutputSchema,
    timeoutMs: input.timeoutMs,
  });
  const evaluations: PrecisionAssertionEvaluation[] = [];

  for (const target of targets) {
    try {
      evaluations.push(resolveJudgmentItem(target, output));
    } catch (initialError) {
      try {
        evaluations.push(await repairPrecisionJudgment(input, target));
      } catch (repairError) {
        const initialMessage =
          initialError instanceof Error
            ? initialError.message
            : String(initialError);
        const repairMessage =
          repairError instanceof Error
            ? repairError.message
            : String(repairError);
        const message = `${initialMessage} Isolated repair failed: ${repairMessage}`;
        input.onWarning?.({
          pass: "precision-judgment",
          itemId: target.assertion.id,
          message,
        });
        evaluations.push({
          assertion: target.assertion.statement,
          location: target.assertion.relativePath,
          verdict: "indeterminate",
          evidenceIds: [],
          rationale: `Evaluator could not repair this precision judgment: ${message}`,
        });
      }
    }
  }

  return evaluations;
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
      units: [],
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
  const extraction = await extractAssertions(
    input,
    extractableSections,
    extractionBatchSize,
  );
  const { inventory, assertions } = buildInventory(
    input.checkpointId,
    orderedSections.length,
    extractableSections.length,
    excludedSections,
    extraction.units,
    extraction.assertions,
  );
  await input.onInventory?.(inventory);

  if (assertions.length === 0) {
    return [];
  }

  const ledgerResults = await runLedgerAccounting(input, assertions);
  const assertionById = new Map(
    assertions.map((assertion): [string, ExtractedArtifactAssertion] => [
      assertion.id,
      assertion,
    ]),
  );
  const evaluationByAssertion = new Map<string, PrecisionAssertionEvaluation>();
  const unaccountedAssertions: ExtractedArtifactAssertion[] = [];

  for (const ledgerResult of ledgerResults) {
    const assertion = assertionById.get(
      ledgerResult.assertionId,
    ) as ExtractedArtifactAssertion;

    if (ledgerResult.verdict === "unaccounted") {
      unaccountedAssertions.push(assertion);
      continue;
    }

    evaluationByAssertion.set(assertion.id, {
      assertion: assertion.statement,
      location: assertion.relativePath,
      verdict:
        ledgerResult.verdict === "contradicted"
          ? "unsupported"
          : ledgerResult.verdict,
      unsupportedReason:
        ledgerResult.verdict === "contradicted" ? "contradicted" : undefined,
      verificationSource:
        ledgerResult.verdict === "indeterminate" ? undefined : "ledger",
      evidenceIds: ledgerResult.factVersionIds,
      rationale: ledgerResult.rationale,
    });
  }

  if (unaccountedAssertions.length === 0) {
    return assertions.map(
      (assertion) =>
        evaluationByAssertion.get(assertion.id) as PrecisionAssertionEvaluation,
    );
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
  const completeInventories = evidenceSections.filter(isCompleteInventory);
  const initialTargets = unaccountedAssertions.map(
    (assertion): PrecisionJudgmentTarget => ({
      assertion,
      evidence: evidenceDossier(
        [],
        evidenceIndex
          .search(assertion.statement, DEFAULT_EVIDENCE_TOP_K)
          .map((ranked) => ranked.section as EvidenceSection),
        completeInventories,
      ),
    }),
  );
  const examinedEvidenceByAssertion = new Map<string, Set<string>>();

  if (evidenceSections.length === 0) {
    for (const assertion of unaccountedAssertions) {
      evaluationByAssertion.set(assertion.id, {
        assertion: assertion.statement,
        location: assertion.relativePath,
        verdict: "unsupported",
        unsupportedReason: "not-established",
        verificationSource: "source",
        evidenceIds: [],
        rationale: "The checkpoint contains no source evidence.",
      });
    }

    return assertions.map(
      (assertion) =>
        evaluationByAssertion.get(assertion.id) as PrecisionAssertionEvaluation,
    );
  }

  for (const targetBatch of batch(initialTargets, judgmentBatchSize)) {
    const visibleTargetBatch = shareBatchEvidence(targetBatch);
    const evaluations = await resolvePrecisionBatchResilient(
      input,
      visibleTargetBatch,
    );

    for (const target of visibleTargetBatch) {
      examinedEvidenceByAssertion.set(
        target.assertion.id,
        new Set(target.evidence.map((evidence) => evidence.id)),
      );
    }

    for (const evaluation of evaluations) {
      const target = visibleTargetBatch.find(
        (candidate) => candidate.assertion.statement === evaluation.assertion,
      ) as PrecisionJudgmentTarget;
      evaluationByAssertion.set(target.assertion.id, evaluation);
    }
  }

  for (const target of initialTargets) {
    const initial = evaluationByAssertion.get(target.assertion.id);

    if (
      initial?.verdict !== "unsupported" ||
      initial.unsupportedReason !== "not-established"
    ) {
      continue;
    }

    const examined =
      examinedEvidenceByAssertion.get(target.assertion.id) ?? new Set<string>();
    const remaining = evidenceIndex
      .sections()
      .filter((evidence) => !examined.has(evidence.id)) as EvidenceSection[];
    let dossier = evidenceSections.filter((evidence) =>
      examined.has(evidence.id),
    );

    for (const evidenceBatch of batch(
      remaining,
      EVIDENCE_FALLBACK_BATCH_SIZE,
    )) {
      dossier = evidenceDossier(dossier, evidenceBatch, completeInventories);
      const fallbackTarget = {
        assertion: target.assertion,
        evidence: dossier,
      };
      const [evaluation] = await resolvePrecisionBatchResilient(input, [
        fallbackTarget,
      ]);
      evaluationByAssertion.set(target.assertion.id, evaluation);

      if (
        evaluation.verdict !== "unsupported" ||
        evaluation.unsupportedReason !== "not-established"
      ) {
        break;
      }
    }
  }

  return assertions.map(
    (assertion) =>
      evaluationByAssertion.get(assertion.id) as PrecisionAssertionEvaluation,
  );
}
