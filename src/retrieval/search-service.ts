import { buildRepositoryCorpus } from "./repository-index.js";
import {
  rankBm25,
  rankKeyword,
  reciprocalRankFusion,
  tokenize,
} from "./ranking.js";
import { SemanticRanker, type EmbeddingProvider } from "./semantic.js";
import type {
  BriefInvariant,
  ChangeSurfaceResponse,
  CoverageReviewItem,
  DocumentRole,
  EvidenceReference,
  IndexedChunk,
  OkfConcept,
  OpenWikiMetadata,
  RankedHit,
  RepositoryCorpus,
  SearchResponse,
  SearchResultItem,
  SearchScope,
  SourceSurfaceCategory,
  ValidationReference,
} from "./types.js";

const DEFAULT_LIMIT = 6;
const MAX_SEARCH_LIMIT = 10;
const MAX_SURFACE_LIMIT = 8;
const MAX_QUERY_LENGTH = 500;
const MAX_SNIPPET_LENGTH = 220;
const MAX_CHANGED_PATHS = 50;
const MAX_CONCEPTS = 3;
const MAX_INVARIANTS = 4;
const MAX_VALIDATION_COMMANDS = 3;

export interface RetrievalServiceOptions {
  embeddingProvider: EmbeddingProvider;
  repoRoot: string;
  wikiRoot: string;
}

export class RetrievalService {
  private corpusPromise: Promise<RepositoryCorpus> | undefined;
  private readonly semantic: SemanticRanker;

  constructor(private readonly options: RetrievalServiceOptions) {
    this.semantic = new SemanticRanker(options.embeddingProvider);
  }

  async search(
    query: string,
    scope: SearchScope = "all",
    limit = DEFAULT_LIMIT,
  ): Promise<SearchResponse> {
    const corpus = await this.corpus();
    const validQuery = validateQuery(query);
    const validScope = validateScope(scope);
    const chunks = scopedChunks(corpus.chunks, validScope);
    const semantic = await this.semantic.rank(chunks, validQuery);
    const lists = [
      { hits: rankKeyword(chunks, validQuery), name: "keyword", weight: 0.75 },
      { hits: rankBm25(chunks, validQuery), name: "bm25", weight: 1 },
      { hits: semantic.hits, name: "semantic", weight: 0.9 },
    ];
    if (validScope === "all" || validScope === "wiki") {
      lists.push({
        hits: rankOkfGraph(corpus, validQuery, 1),
        name: "okf_graph",
        weight: 0.8,
      });
    }
    const ranked = reciprocalRankFusion(lists);
    return response(
      validQuery,
      validScope === "tests" ? deduplicateTestMirrors(ranked) : ranked,
      normalizeLimit(limit, MAX_SEARCH_LIMIT, DEFAULT_LIMIT),
      validScope,
    );
  }

  async changeSurface(
    query: string,
    limit = 6,
    changedPaths: string[] = [],
  ): Promise<ChangeSurfaceResponse> {
    const corpus = await this.corpus();
    const validQuery = validateQuery(query);
    const validLimit = normalizeLimit(limit, MAX_SURFACE_LIMIT, 6);
    const validChangedPaths = validateChangedPaths(changedPaths);
    const metadataRoles = inferQueryRoles(validQuery);
    const conceptChunks = selectConceptChunks(
      corpus,
      validQuery,
      metadataRoles,
      MAX_CONCEPTS,
    );
    const selectedConcepts = selectedOkfConcepts(corpus, conceptChunks);
    const metadata = mergeMetadata(selectedConcepts);
    const referencedPaths = new Set([
      ...extractPaths(conceptChunks.map((chunk) => chunk.text).join("\n")),
      ...metadata.sourcePaths,
      ...metadata.testPaths,
    ]);
    const symbols = [...new Set(metadata.symbols)];
    const sourceQuery = [validQuery, ...symbols.slice(0, 10)].join(" ");
    const sourceCorpus = sourceChunks(corpus.chunks).filter(
      (chunk) => !isRepositoryGuidance(chunk),
    );
    const source = boostReferencedPaths(
      reciprocalRankFusion([
        {
          hits: rankBm25(sourceCorpus, sourceQuery),
          name: "bm25",
          weight: 1,
        },
        {
          hits: rankKeyword(sourceCorpus, sourceQuery),
          name: "keyword",
          weight: 0.9,
        },
      ]),
      referencedPaths,
    ).slice(0, 120);
    const invariants = collectInvariants(
      selectedConcepts,
      conceptChunks,
      validQuery,
    );
    const ownershipHits = uniquePathHits(
      source.filter(
        (hit) =>
          !isTestChunk(hit.chunk) &&
          categorize(hit.chunk).includes("implementation"),
      ),
    ).slice(0, Math.min(3, validLimit));
    const deliveryRequested = requiresDeliveryReview(
      validQuery,
      metadataRoles,
      validChangedPaths,
    );
    const deliveryHits = deliveryRequested
      ? uniquePathHits(
          source.filter((hit) =>
            categorize(hit.chunk).some((category) =>
              [
                "consumer",
                "exports",
                "initialization",
                "publish_generated",
              ].includes(category),
            ),
          ),
        ).slice(0, 2)
      : [];
    const testRankers = [
      {
        hits: rankBm25(sourceCorpus.filter(isTestChunk), validQuery),
        name: "test_bm25",
        weight: 1.2,
      },
      {
        hits: rankKeyword(sourceCorpus.filter(isTestChunk), validQuery),
        name: "test_keyword",
        weight: 1,
      },
    ];
    if (invariants.length > 0) {
      testRankers.push({
        hits: rankBm25(
          sourceCorpus.filter(isTestChunk),
          invariants.map((invariant) => invariant.text).join(" "),
        ),
        name: "invariant_bm25",
        weight: 0.35,
      });
    }
    const testHits = uniquePathHits(
      deduplicateTestMirrors(
        boostReferencedPaths(
          reciprocalRankFusion(testRankers),
          new Set(metadata.testPaths),
          2.5,
        ),
      ),
    ).slice(0, Math.min(3, validLimit));
    const ownership = ownershipHits.map((hit) =>
      toEvidenceReference(hit, ownershipReason(hit.chunk, referencedPaths)),
    );
    const tests = testHits.map((hit) =>
      toEvidenceReference(hit, "Analogous behavior or regression coverage."),
    );
    const delivery = deliveryHits.map((hit) =>
      toEvidenceReference(hit, deliveryReason(hit.chunk)),
    );
    const validation = collectValidation(selectedConcepts, conceptChunks);
    const unknowns = collectUnknowns({
      delivery,
      deliveryRequested,
      invariants,
      ownership,
      tests,
    });
    const review = buildCoverageReview(
      validChangedPaths,
      [...ownership, ...delivery],
      referencedPaths,
    );
    return {
      brief: {
        delivery,
        invariants,
        ownership,
        tests,
        unknowns,
        validation,
      },
      provenance: {
        changedPaths: validChangedPaths,
        metadataRoles,
        wikiConceptPaths: [
          ...new Set(conceptChunks.map((chunk) => chunk.path)),
        ],
        wikiReferencedSourcePaths: [...referencedPaths],
      },
      query: validQuery,
      ...(review.length > 0 ? { review } : {}),
    };
  }

  private corpus(): Promise<RepositoryCorpus> {
    this.corpusPromise ??= buildRepositoryCorpus(this.options);
    return this.corpusPromise;
  }
}

function rankOkfGraph(
  corpus: RepositoryCorpus,
  query: string,
  hops: number,
): RankedHit[] {
  const wikiChunks = corpus.chunks.filter((chunk) => chunk.scope === "wiki");
  const seeds = rankBm25(wikiChunks, query).slice(0, 20);
  const scores = new Map<string, number>();
  const seedConcepts = new Set<string>();
  for (const [index, hit] of seeds.entries()) {
    if (!hit.chunk.conceptPath) continue;
    const score = 1 / (index + 1);
    scores.set(
      hit.chunk.conceptPath,
      (scores.get(hit.chunk.conceptPath) ?? 0) + score,
    );
    seedConcepts.add(hit.chunk.conceptPath);
  }
  let frontier = seedConcepts;
  for (let hop = 0; hop < hops; hop += 1) {
    const next = new Set<string>();
    for (const conceptPath of frontier) {
      const concept = corpus.concepts.get(conceptPath);
      if (!concept) continue;
      const base = scores.get(conceptPath) ?? 0;
      for (const neighbor of graphNeighbors(concept, query)) {
        scores.set(neighbor, (scores.get(neighbor) ?? 0) + base * 0.35);
        next.add(neighbor);
      }
    }
    frontier = next;
  }
  return [...scores.entries()]
    .map(([conceptPath, score]) => {
      const chunk = bestConceptChunk(wikiChunks, conceptPath, query);
      return chunk ? { chunk, score } : null;
    })
    .filter((hit): hit is RankedHit => hit !== null)
    .sort((left, right) => right.score - left.score);
}

function graphNeighbors(concept: OkfConcept, query: string): Set<string> {
  const queryTerms = new Set(tokenize(query));
  const desiredKinds = new Set<OkfConcept["relationships"][number]["kind"]>([
    "dependency",
    "lifecycle",
    "related",
  ]);
  if (/\b(?:export|package|public|publish|release|ship)\w*\b/iu.test(query)) {
    desiredKinds.add("delivery");
  }
  return new Set(
    concept.relationships
      .filter(
        (relationship) =>
          desiredKinds.has(relationship.kind) &&
          (relationship.kind !== "related" ||
            tokenize(relationship.context).some((term) =>
              queryTerms.has(term),
            )),
      )
      .map((relationship) => relationship.target),
  );
}

function bestConceptChunk(
  chunks: IndexedChunk[],
  conceptPath: string,
  query: string,
): IndexedChunk | undefined {
  return (
    rankBm25(
      chunks.filter((chunk) => chunk.conceptPath === conceptPath),
      query,
    )[0]?.chunk ?? chunks.find((chunk) => chunk.conceptPath === conceptPath)
  );
}

function selectConceptChunks(
  corpus: RepositoryCorpus,
  query: string,
  desiredRoles: DocumentRole[],
  limit: number,
): IndexedChunk[] {
  const wikiChunks = corpus.chunks.filter((chunk) => chunk.scope === "wiki");
  const representatives = [...corpus.concepts.values()]
    .map((concept) => {
      const base = wikiChunks.find(
        (chunk) => chunk.conceptPath === concept.path,
      );
      if (!base) return undefined;
      return {
        ...base,
        fields: [
          concept.title,
          concept.type,
          concept.description,
          concept.roles.join(" "),
          concept.tags.join(" "),
          concept.resource,
          concept.metadata.changeKinds.join(" "),
          concept.metadata.sourcePaths.join(" "),
          concept.metadata.symbols.join(" "),
          concept.metadata.testPaths.join(" "),
        ]
          .filter(Boolean)
          .join("\n"),
        text: concept.description ?? "",
      } satisfies IndexedChunk;
    })
    .filter((chunk): chunk is IndexedChunk => chunk !== undefined);
  const relevantRepresentatives = representatives.filter((chunk) =>
    hasDistinctiveMetadataMatch(chunk, query),
  );
  if (relevantRepresentatives.length === 0) return [];
  const neighborPaths = new Set<string>();
  for (const seed of rankBm25(relevantRepresentatives, query).slice(0, 4)) {
    const concept = seed.chunk.conceptPath
      ? corpus.concepts.get(seed.chunk.conceptPath)
      : undefined;
    if (!concept) continue;
    for (const neighbor of graphNeighbors(concept, query)) {
      neighborPaths.add(neighbor);
    }
  }
  const ranked = reciprocalRankFusion([
    {
      hits: rankBm25(relevantRepresentatives, query),
      name: "metadata_bm25",
      weight: 1,
    },
    {
      hits: rankKeyword(relevantRepresentatives, query),
      name: "metadata_keyword",
      weight: 0.9,
    },
  ])
    .map((hit) => {
      const overlap = hit.chunk.roles.filter((role) =>
        desiredRoles.includes(role),
      ).length;
      const repositoryOnly =
        hit.chunk.roles.includes("repository") &&
        hit.chunk.roles.every((role) =>
          ["repository", "reference"].includes(role),
        );
      return {
        ...hit,
        score:
          hit.score *
          (1 + overlap * 0.18) *
          (neighborPaths.has(hit.chunk.conceptPath ?? "") ? 1.15 : 1) *
          (repositoryOnly ? 0.65 : 1),
      };
    })
    .sort((left, right) => right.score - left.score);
  const selected: RankedHit[] = [];
  const coveredRoles = new Set<DocumentRole>();
  for (const hit of ranked) {
    if (selected.length >= limit) break;
    if (
      selected.some(
        (candidate) => candidate.chunk.conceptPath === hit.chunk.conceptPath,
      )
    ) {
      continue;
    }
    const addsRole = hit.chunk.roles.some(
      (role) => desiredRoles.includes(role) && !coveredRoles.has(role),
    );
    if (selected.length < 2 || addsRole || selected.length + 1 === limit) {
      selected.push(hit);
      hit.chunk.roles.forEach((role) => coveredRoles.add(role));
    }
  }
  return selected
    .map((hit) =>
      hit.chunk.conceptPath
        ? bestConceptChunk(wikiChunks, hit.chunk.conceptPath, query)
        : undefined,
    )
    .filter((chunk): chunk is IndexedChunk => chunk !== undefined);
}

const GENERIC_ROUTING_TERMS = new Set([
  "add",
  "agent",
  "change",
  "cod",
  "code",
  "implement",
  "improve",
  "repository",
  "task",
  "update",
]);

function hasDistinctiveMetadataMatch(
  chunk: IndexedChunk,
  query: string,
): boolean {
  const queryTerms = new Set(
    tokenize(query).filter((term) => !GENERIC_ROUTING_TERMS.has(term)),
  );
  if (queryTerms.size === 0) return true;
  const metadataTerms = new Set(
    tokenize(
      [
        chunk.path,
        chunk.title,
        chunk.description,
        chunk.type,
        chunk.tags.join(" "),
        chunk.roles.join(" "),
        chunk.fields,
      ]
        .filter(Boolean)
        .join(" "),
    ),
  );
  return [...queryTerms].some((term) => metadataTerms.has(term));
}

function selectedOkfConcepts(
  corpus: RepositoryCorpus,
  chunks: IndexedChunk[],
): OkfConcept[] {
  return [
    ...new Map(
      chunks
        .map((chunk) =>
          chunk.conceptPath
            ? corpus.concepts.get(chunk.conceptPath)
            : undefined,
        )
        .filter((concept): concept is OkfConcept => concept !== undefined)
        .map((concept) => [concept.path, concept]),
    ).values(),
  ];
}

function mergeMetadata(concepts: OkfConcept[]): OpenWikiMetadata {
  const merge = (
    select: (metadata: OpenWikiMetadata) => string[],
  ): string[] => [
    ...new Set(concepts.flatMap((concept) => select(concept.metadata))),
  ];
  return {
    changeKinds: merge((metadata) => metadata.changeKinds),
    invariants: merge((metadata) => metadata.invariants),
    roles: [...new Set(concepts.flatMap((concept) => concept.metadata.roles))],
    sourcePaths: merge((metadata) => metadata.sourcePaths),
    symbols: merge((metadata) => metadata.symbols),
    testPaths: merge((metadata) => metadata.testPaths),
    validationCommands: merge((metadata) => metadata.validationCommands),
  };
}

function inferQueryRoles(query: string): DocumentRole[] {
  const roles = new Set<DocumentRole>(["architecture", "domain"]);
  const add = (role: DocumentRole, pattern: RegExp): void => {
    if (pattern.test(query)) roles.add(role);
  };
  add(
    "delivery",
    /\b(?:api|artifact|build|consumer|export|package|public|publish|release|ship)\w*\b/iu,
  );
  add(
    "integration",
    /\b(?:adapter|integration|middleware|plugin|provider|react|router)\w*\b/iu,
  );
  add(
    "operations",
    /\b(?:ci|cli|configure|deploy|development|install|operations|tooling)\w*\b/iu,
  );
  add(
    "testing",
    /\b(?:behavior|compatibility|invariant|regression|test|validate|verify)\w*\b/iu,
  );
  add(
    "workflow",
    /\b(?:defer|event|lifecycle|reset|rollback|state|transition|workflow)\w*\b/iu,
  );
  return [...roles];
}

function collectInvariants(
  concepts: OkfConcept[],
  chunks: IndexedChunk[],
  query: string,
): BriefInvariant[] {
  const candidates: (BriefInvariant & { score: number })[] = [];
  for (const concept of concepts) {
    for (const invariant of concept.metadata.invariants) {
      candidates.push({
        lineEnd: 1,
        lineStart: 1,
        path: concept.path,
        score: invariantScore(invariant, query) + 8,
        text: invariant,
      });
    }
  }
  for (const chunk of chunks) {
    const lines = chunk.text
      .split(/\r?\n/gu)
      .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/u, "").trim())
      .filter((line) => line.length >= 24 && line.length <= 500);
    for (const line of lines) {
      if (!isInvariantText(line)) continue;
      if (!hasTermOverlap(line, query)) continue;
      candidates.push({
        lineEnd: chunk.lineEnd,
        lineStart: chunk.lineStart,
        path: chunk.path,
        score: invariantScore(line, query),
        text: compactText(line, 240),
      });
    }
  }
  const seen = new Set<string>();
  return candidates
    .sort((left, right) => right.score - left.score)
    .filter((candidate) => candidate.score > 0)
    .filter((candidate) => {
      const key = candidate.text.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_INVARIANTS)
    .map((candidate) => ({
      lineEnd: candidate.lineEnd,
      lineStart: candidate.lineStart,
      path: candidate.path,
      text: candidate.text,
    }));
}

function isInvariantText(value: string): boolean {
  return /\b(?:must|should not|do not|don't|never|preserve|remain|only|before|after|unchanged|idempotent|reset|reuse|invariant|required|incomplete)\b/iu.test(
    value,
  );
}

function invariantScore(value: string, query: string): number {
  const queryTerms = new Set(tokenize(query));
  const overlap = tokenize(value).filter((term) => queryTerms.has(term)).length;
  const force = /\b(?:must|do not|don't|never|required|invariant)\b/iu.test(
    value,
  )
    ? 4
    : 0;
  return overlap * 2 + force;
}

function hasTermOverlap(value: string, query: string): boolean {
  const queryTerms = new Set(
    tokenize(query).filter((term) => !GENERIC_ROUTING_TERMS.has(term)),
  );
  return tokenize(value).some((term) => queryTerms.has(term));
}

function collectValidation(
  concepts: OkfConcept[],
  chunks: IndexedChunk[],
): ValidationReference[] {
  const candidates: ValidationReference[] = [];
  for (const concept of concepts) {
    for (const command of concept.metadata.validationCommands) {
      if (isSafeDisplayedCommand(command)) {
        candidates.push({ command, path: concept.path });
      }
    }
  }
  for (const chunk of chunks) {
    for (const match of chunk.text.matchAll(/`([^`\n]{3,300})`/gu)) {
      const command = match[1]?.trim();
      if (command && looksLikeValidationCommand(command)) {
        candidates.push({ command, path: chunk.path });
      }
    }
  }
  const seen = new Set<string>();
  return candidates
    .filter((candidate) => {
      if (seen.has(candidate.command)) return false;
      seen.add(candidate.command);
      return true;
    })
    .slice(0, MAX_VALIDATION_COMMANDS);
}

function looksLikeValidationCommand(value: string): boolean {
  return (
    isSafeDisplayedCommand(value) &&
    /^(?:bun|cargo|go|make|npm|npx|pnpm|pytest|python\s+-m\s+pytest|ruff|uv\s+run|yarn)\b/iu.test(
      value,
    ) &&
    /\b(?:build|check|lint|test|typecheck|verify|vitest)\b/iu.test(value)
  );
}

function isSafeDisplayedCommand(value: string): boolean {
  return (
    value.length <= 300 &&
    !/[\r\n\0]/u.test(value) &&
    !/(?:\.env|credential|private[_-]?key|secret|token)/iu.test(value)
  );
}

function uniquePathHits(hits: RankedHit[]): RankedHit[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    if (seen.has(hit.chunk.path)) return false;
    seen.add(hit.chunk.path);
    return true;
  });
}

function toEvidenceReference(
  hit: RankedHit,
  reason: string,
): EvidenceReference {
  return {
    lineEnd: hit.chunk.lineEnd,
    lineStart: hit.chunk.lineStart,
    path: hit.chunk.path,
    reason,
    ...(hit.chunk.testNames && hit.chunk.testNames.length > 0
      ? { testNames: hit.chunk.testNames.slice(0, 6) }
      : {}),
    ...(hit.chunk.title ? { title: hit.chunk.title } : {}),
  };
}

function ownershipReason(chunk: IndexedChunk, references: Set<string>): string {
  return pathMatchesReference(chunk.path, references)
    ? "Named by the selected OpenWiki concept as an implementation anchor."
    : "Highest-ranked implementation ownership candidate; verify in source.";
}

function deliveryReason(chunk: IndexedChunk): string {
  const categories = categorize(chunk);
  if (categories.includes("exports"))
    return "Public or package export surface.";
  if (categories.includes("publish_generated")) {
    return "Generated, packaged, or publish-facing surface.";
  }
  if (categories.includes("consumer")) return "Consumer-facing usage surface.";
  return "Initialization or registration surface.";
}

function requiresDeliveryReview(
  query: string,
  roles: DocumentRole[],
  changedPaths: string[],
): boolean {
  return (
    roles.includes("delivery") ||
    /\b(?:api|consumer|export|package|public|publish|release|ship)\w*\b/iu.test(
      query,
    ) ||
    changedPaths.some((candidate) =>
      /(?:^|\/)(?:index\.[cm]?[jt]sx?|package\.json|dist|publish)(?:$|\/)/u.test(
        candidate,
      ),
    )
  );
}

function collectUnknowns(input: {
  delivery: EvidenceReference[];
  deliveryRequested: boolean;
  invariants: BriefInvariant[];
  ownership: EvidenceReference[];
  tests: EvidenceReference[];
}): string[] {
  const unknowns: string[] = [];
  if (input.ownership.length === 0) {
    unknowns.push(
      "No implementation owner was established; locate it in source.",
    );
  }
  if (input.invariants.length === 0) {
    unknowns.push("No explicit behavioral invariant was found in the wiki.");
  }
  if (input.tests.length === 0) {
    unknowns.push(
      "No analogous focused test was found; add task-specific coverage.",
    );
  }
  if (input.deliveryRequested && input.delivery.length === 0) {
    unknowns.push(
      "No shipped-surface evidence was found; verify exports manually.",
    );
  }
  return unknowns;
}

function buildCoverageReview(
  changedPaths: string[],
  evidence: EvidenceReference[],
  referencedPaths: Set<string>,
): CoverageReviewItem[] {
  if (changedPaths.length === 0) return [];
  const normalizedChanges = new Set(changedPaths);
  const candidates = [...evidence.map((item) => item.path), ...referencedPaths];
  const seen = new Set<string>();
  return candidates
    .filter((candidate) => {
      if (seen.has(candidate) || normalizedChanges.has(candidate)) return false;
      seen.add(candidate);
      return true;
    })
    .slice(0, 4)
    .map((candidate) => ({
      path: candidate,
      reason:
        "Documented adjacent surface is absent from changed_paths; verify that it is intentionally unaffected.",
    }));
}

function boostReferencedPaths(
  hits: RankedHit[],
  paths: Set<string>,
  multiplier = 1.6,
): RankedHit[] {
  return hits
    .map((hit) => ({
      ...hit,
      score:
        hit.score *
        (pathMatchesReference(hit.chunk.path, paths) ? multiplier : 1),
    }))
    .sort((left, right) => right.score - left.score);
}

function pathMatchesReference(path: string, references: Set<string>): boolean {
  return [...references].some(
    (candidate) => path === candidate || path.endsWith(candidate),
  );
}

function categorize(chunk: IndexedChunk): SourceSurfaceCategory[] {
  const value = `${chunk.path}\n${chunk.text}`;
  const categories = new Set<SourceSurfaceCategory>();
  if (
    /\b(?:exports|entrypoint|public api)\b/iu.test(value) ||
    /\bexport\s+(?:\*|\{[^}]+\})\s+from\b/iu.test(chunk.text) ||
    /(?:^|\/)index\.[cm]?[jt]sx?$/u.test(chunk.path)
  ) {
    categories.add("exports");
  }
  if (
    /\b(?:publish|generated|bundle|build artifact|package\.json|dist)\b/iu.test(
      value,
    )
  ) {
    categories.add("publish_generated");
  }
  if (
    /\b(?:initialize|register|registry|factory|createStore|createWorld|setup)\b/u.test(
      value,
    )
  ) {
    categories.add("initialization");
  }
  if (isTestChunk(chunk)) {
    categories.add("tests");
  }
  if (
    /\bimport\s+.+\s+from\s+['"][^./]/u.test(chunk.text) ||
    /(?:^|\/)(?:examples?|apps?|publish\/tests)(?:\/|$)/iu.test(chunk.path)
  ) {
    categories.add("consumer");
  }
  if (categories.size === 0 || /(?:^|\/)src(?:\/|$)/u.test(chunk.path)) {
    categories.add("implementation");
  }
  return [...categories];
}

function isTestChunk(chunk: IndexedChunk): boolean {
  return (
    /(?:^|\/)(?:test|tests|spec|specs)(?:\/|$)/iu.test(chunk.path) ||
    /(?:^|[._-])(?:test|tests|spec|specs)(?:[._-]|$)/iu.test(chunk.path)
  );
}

function isRepositoryGuidance(chunk: IndexedChunk): boolean {
  return /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/iu.test(chunk.path);
}

function deduplicateTestMirrors(hits: RankedHit[]): RankedHit[] {
  const deduplicated = new Map<string, RankedHit>();
  for (const hit of hits) {
    const key = canonicalTestKey(hit.chunk);
    const current = deduplicated.get(key);
    if (
      !current ||
      (isGeneratedTestPath(current.chunk.path) &&
        !isGeneratedTestPath(hit.chunk.path))
    ) {
      deduplicated.set(key, hit);
    }
  }
  return [...deduplicated.values()];
}

function canonicalTestKey(chunk: IndexedChunk): string {
  const normalizedPath = chunk.path
    .replace(
      /(?:^|\/)packages\/publish\/tests\/(?:core\/)?/u,
      "packages/core/tests/",
    )
    .replace(/(?:^|\/)(?:generated|publish)\/tests\//u, "tests/");
  return `${normalizedPath}:${chunk.lineStart}:${(chunk.testNames ?? []).join("|")}`;
}

function isGeneratedTestPath(value: string): boolean {
  return /(?:^|\/)(?:generated|publish)(?:\/|$)/u.test(value);
}

function extractPaths(value: string): Set<string> {
  const paths = value.match(
    /(?:^|[\s`("'])([A-Za-z0-9_.-]+\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)/gmu,
  );
  return new Set(
    (paths ?? []).map((item) => item.trim().replace(/^[`("']/u, "")),
  );
}

function response(
  query: string,
  hits: RankedHit[],
  limit: number,
  scope: SearchScope,
): SearchResponse {
  return {
    query,
    results: hits.slice(0, limit).map(toResultItem),
    scope,
  };
}

function toResultItem(hit: RankedHit): SearchResultItem {
  return {
    ...(hit.chunk.heading ? { heading: hit.chunk.heading } : {}),
    lineEnd: hit.chunk.lineEnd,
    lineStart: hit.chunk.lineStart,
    path: hit.chunk.path,
    snippet: compactSnippet(hit.chunk.text),
    ...(hit.chunk.tags.length > 0 ? { tags: hit.chunk.tags } : {}),
    ...(hit.chunk.testNames && hit.chunk.testNames.length > 0
      ? { testNames: hit.chunk.testNames }
      : {}),
    ...(hit.chunk.title ? { title: hit.chunk.title } : {}),
    ...(hit.chunk.type ? { type: hit.chunk.type } : {}),
  };
}

function compactSnippet(value: string): string {
  return compactText(value, MAX_SNIPPET_LENGTH);
}

function compactText(value: string, limit: number): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, limit);
}

function scopedChunks(
  chunks: IndexedChunk[],
  scope: SearchScope,
): IndexedChunk[] {
  const valid = validateScope(scope);
  if (valid === "all") return chunks;
  if (valid === "wiki") {
    return chunks.filter((chunk) => chunk.scope === "wiki");
  }
  if (valid === "tests") {
    return sourceChunks(chunks).filter(isTestChunk);
  }
  return sourceChunks(chunks).filter((chunk) => !isTestChunk(chunk));
}

function validateScope(scope: SearchScope): SearchScope {
  if (
    scope !== "all" &&
    scope !== "source_code" &&
    scope !== "tests" &&
    scope !== "wiki"
  ) {
    throw new Error("scope must be all, source_code, tests, or wiki.");
  }
  return scope;
}

function sourceChunks(chunks: IndexedChunk[]): IndexedChunk[] {
  return chunks.filter((chunk) => chunk.scope === "source_code");
}

function validateQuery(query: string): string {
  if (
    typeof query !== "string" ||
    !query.trim() ||
    query.length > MAX_QUERY_LENGTH
  ) {
    throw new Error(`query must be 1-${MAX_QUERY_LENGTH} characters.`);
  }
  return query.trim();
}

function validateChangedPaths(paths: string[]): string[] {
  if (!Array.isArray(paths)) {
    throw new Error(
      "changed_paths must be an array of repository-relative paths.",
    );
  }
  if (paths.length > MAX_CHANGED_PATHS) {
    throw new Error(
      `changed_paths must contain at most ${MAX_CHANGED_PATHS} paths.`,
    );
  }
  return [
    ...new Set(
      paths.map((candidate) => {
        if (
          typeof candidate !== "string" ||
          !candidate.trim() ||
          candidate.length > 300 ||
          candidate.startsWith("/") ||
          candidate.includes("\\") ||
          candidate.split("/").some((part) => part === "" || part === "..") ||
          /(?:^|\/)(?:\.env(?:\..*)?|credentials\.json|secrets?|tokens?)(?:\/|$)/iu.test(
            candidate,
          )
        ) {
          throw new Error(
            "changed_paths must contain safe repository-relative paths.",
          );
        }
        return candidate.trim();
      }),
    ),
  ];
}

function normalizeLimit(
  limit: number,
  maximum: number,
  fallback: number,
): number {
  if (!Number.isInteger(limit)) return fallback;
  return Math.max(1, Math.min(maximum, limit));
}
