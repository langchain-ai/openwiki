import type { IndexedChunk, RankedHit } from "./types.js";

const STOP_WORDS = new Set([
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
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

const SYNONYM_GROUPS = [
  [
    "api",
    "consumer",
    "entrypoint",
    "export",
    "package",
    "public",
    "publish",
    "surface",
  ],
  ["build", "bundle", "copy", "dist", "generated", "mirror", "release", "sync"],
  ["factory", "initialize", "install", "register", "registry", "setup", "wire"],
  ["assert", "check", "spec", "test", "validate", "verify"],
  ["defer", "buffer", "batch", "command", "flush", "queue"],
  ["predicate", "filter", "query", "select", "where"],
  ["relation", "edge", "link", "pair", "target"],
  ["aspect", "composite", "trait", "mixin", "schema"],
  ["diff", "restore", "rollback", "snapshot", "state"],
  ["initial", "baseline", "empty", "first", "setup"],
  ["add", "added", "enter", "gain", "insert", "true"],
  ["remove", "removed", "exit", "lose", "delete", "false"],
  ["change", "changed", "mutate", "transition", "update"],
  ["unchanged", "noop", "idempotent", "stable"],
  ["independent", "isolation", "instance", "tracker"],
  ["reset", "reuse", "window", "observation", "generation"],
  ["defer", "reentrant", "coalesce", "net", "flush"],
  ["compose", "composition", "combine", "mixed"],
] as const;

const SYNONYMS = buildSynonyms();

export function tokenize(value: string): string[] {
  const separated = value
    .replace(/[_-]+/gu, " ")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .toLowerCase();
  const terms = separated.match(/[a-z0-9]+/gu) ?? [];
  return terms
    .map((term) => stem(term))
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term));
}

export function expandQueryTerms(query: string): string[] {
  const base = tokenize(query);
  const expanded = new Set(base);
  for (const term of base) {
    for (const synonym of SYNONYMS.get(term) ?? []) expanded.add(synonym);
  }
  return [...expanded];
}

export function rankKeyword(
  chunks: IndexedChunk[],
  query: string,
): RankedHit[] {
  const phrase = query.trim().toLowerCase();
  const queryTerms = expandQueryTerms(query);
  return chunks
    .map((chunk) => {
      const path = chunk.path.toLowerCase();
      const title = `${chunk.title ?? ""} ${chunk.heading ?? ""}`.toLowerCase();
      const metadata = chunk.fields.toLowerCase();
      const text = chunk.text.toLowerCase();
      const pathTerms = new Set(tokenize(path));
      const titleTerms = new Set(tokenize(title));
      const metadataTerms = new Set(tokenize(metadata));
      const textTerms = new Set(tokenize(text));
      let score = 0;
      if (phrase) {
        if (path.includes(phrase)) score += 10;
        if (title.includes(phrase)) score += 9;
        if (metadata.includes(phrase)) score += 7;
        if (text.includes(phrase)) score += 5;
      }
      for (const term of queryTerms) {
        if (path.includes(term) || pathTerms.has(term)) score += 3.5;
        if (title.includes(term) || titleTerms.has(term)) score += 3;
        if (metadata.includes(term) || metadataTerms.has(term)) score += 2;
        if (text.includes(term) || textTerms.has(term)) score += 1;
      }
      return { chunk, score };
    })
    .filter((hit) => hit.score > 0)
    .sort(compareHits);
}

export function rankBm25(chunks: IndexedChunk[], query: string): RankedHit[] {
  const queryTerms = expandQueryTerms(query);
  if (queryTerms.length === 0 || chunks.length === 0) return [];
  const documents = chunks.map((chunk) => tokenize(searchableText(chunk)));
  const averageLength =
    documents.reduce((sum, terms) => sum + terms.length, 0) /
      documents.length || 1;
  const documentFrequency = new Map<string, number>();
  for (const terms of documents) {
    for (const term of new Set(terms)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const k1 = 1.5;
  const b = 0.75;
  return chunks
    .map((chunk, index) => {
      const terms = documents[index] ?? [];
      const frequencies = frequenciesOf(terms);
      let score = 0;
      for (const term of queryTerms) {
        const frequency = frequencies.get(term) ?? 0;
        if (frequency === 0) continue;
        const df = documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5));
        const denominator =
          frequency + k1 * (1 - b + b * (terms.length / averageLength));
        score += idf * ((frequency * (k1 + 1)) / denominator);
      }
      if (
        chunk.title &&
        queryTerms.some((term) => tokenize(chunk.title ?? "").includes(term))
      ) {
        score *= 1.35;
      }
      if (queryTerms.some((term) => tokenize(chunk.path).includes(term)))
        score *= 1.2;
      return { chunk, score };
    })
    .filter((hit) => hit.score > 0)
    .sort(compareHits);
}

export function rankLocalVectors(
  chunks: IndexedChunk[],
  query: string,
): RankedHit[] {
  const queryVector = vectorize(query);
  return chunks
    .map((chunk) => ({
      chunk,
      score: cosine(queryVector, vectorize(searchableText(chunk))),
    }))
    .filter((hit) => hit.score > 0)
    .sort(compareHits);
}

export function reciprocalRankFusion(
  rankedLists: { hits: RankedHit[]; name: string; weight: number }[],
  k = 60,
): RankedHit[] {
  const fused = new Map<string, RankedHit>();
  for (const list of rankedLists) {
    list.hits.forEach((hit, index) => {
      const contribution = list.weight / (k + index + 1);
      const existing = fused.get(hit.chunk.id) ?? {
        chunk: hit.chunk,
        score: 0,
        signals: {},
      };
      existing.score += contribution;
      existing.signals = {
        ...(existing.signals ?? {}),
        [list.name]: hit.score,
      };
      fused.set(hit.chunk.id, existing);
    });
  }
  return [...fused.values()].sort(compareHits);
}

export function searchableText(chunk: IndexedChunk): string {
  return [
    chunk.path,
    chunk.title,
    chunk.heading,
    chunk.description,
    chunk.type,
    chunk.roles.join(" "),
    chunk.tags.join(" "),
    chunk.resource,
    chunk.fields,
    chunk.text,
  ]
    .filter(Boolean)
    .join("\n");
}

function vectorize(value: string, dimensions = 768): Float64Array {
  const vector = new Float64Array(dimensions);
  const terms = expandTermsForVector(value);
  for (const term of terms) {
    const index = fnv1a(term) % dimensions;
    const sign = (fnv1a(`sign:${term}`) & 1) === 0 ? 1 : -1;
    vector[index] += sign;
  }
  return vector;
}

function expandTermsForVector(value: string): string[] {
  const terms = tokenize(value);
  const expanded = [...terms];
  for (const term of terms) {
    for (const synonym of SYNONYMS.get(term) ?? []) expanded.push(synonym);
  }
  for (let index = 0; index + 1 < terms.length; index += 1) {
    expanded.push(`${terms[index]}:${terms[index + 1]}`);
  }
  return expanded;
}

function cosine(left: Float64Array, right: Float64Array): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

function frequenciesOf(terms: string[]): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const term of terms)
    frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  return frequencies;
}

function compareHits(left: RankedHit, right: RankedHit): number {
  return (
    right.score - left.score || left.chunk.path.localeCompare(right.chunk.path)
  );
}

function stem(term: string): string {
  if (term.length > 5 && term.endsWith("ing")) return term.slice(0, -3);
  if (term.length > 4 && term.endsWith("ed")) return term.slice(0, -2);
  if (term.length > 4 && term.endsWith("es")) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s")) return term.slice(0, -1);
  return term;
}

function buildSynonyms(): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const group of SYNONYM_GROUPS) {
    const normalized = group.map((term) => stem(term));
    for (const term of normalized) {
      result.set(
        term,
        normalized.filter((candidate) => candidate !== term),
      );
    }
  }
  return result;
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
