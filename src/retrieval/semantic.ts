import { rankBm25, rankLocalVectors, searchableText } from "./ranking.js";
import type { IndexedChunk, RankedHit } from "./types.js";

export type EmbeddingProvider = "local" | "openai";

const OPENAI_CANDIDATE_LIMIT = 120;

export class SemanticRanker {
  private readonly vectorCache = new Map<string, number[]>();

  constructor(private readonly provider: EmbeddingProvider) {}

  async rank(
    chunks: IndexedChunk[],
    query: string,
  ): Promise<{ engine: string; hits: RankedHit[] }> {
    if (this.provider !== "openai" || !process.env.OPENAI_API_KEY) {
      return {
        engine: "local-hashed-vector",
        hits: rankLocalVectors(chunks, query),
      };
    }
    try {
      const candidates = selectOpenAiCandidates(chunks, query);
      const embeddings = await this.openAiEmbeddings();
      const queryVector = await embeddings.embedQuery(query);
      const missing = candidates.filter(
        (chunk) => !this.vectorCache.has(chunk.id),
      );
      if (missing.length > 0) {
        const vectors = await embeddings.embedDocuments(
          missing.map(searchableText),
        );
        missing.forEach((chunk, index) => {
          const vector = vectors[index];
          if (vector) this.vectorCache.set(chunk.id, vector);
        });
      }
      const hits = candidates
        .map((chunk) => ({
          chunk,
          score: cosine(queryVector, this.vectorCache.get(chunk.id) ?? []),
        }))
        .filter((hit) => hit.score > 0)
        .sort((left, right) => right.score - left.score);
      return { engine: "openai:text-embedding-3-small", hits };
    } catch {
      return {
        engine: "local-hashed-vector:fallback",
        hits: rankLocalVectors(chunks, query),
      };
    }
  }

  private async openAiEmbeddings(): Promise<{
    embedDocuments(texts: string[]): Promise<number[][]>;
    embedQuery(text: string): Promise<number[]>;
  }> {
    const { OpenAIEmbeddings } = await import("@langchain/openai");
    return new OpenAIEmbeddings({
      apiKey: process.env.OPENAI_API_KEY,
      batchSize: 64,
      configuration: process.env.OPENAI_BASE_URL
        ? { baseURL: process.env.OPENAI_BASE_URL }
        : undefined,
      model: "text-embedding-3-small",
    });
  }
}

function selectOpenAiCandidates(
  chunks: IndexedChunk[],
  query: string,
): IndexedChunk[] {
  const wiki = chunks.filter((chunk) => chunk.scope === "wiki");
  const lexical = rankBm25(chunks, query)
    .slice(0, OPENAI_CANDIDATE_LIMIT)
    .map((hit) => hit.chunk);
  return [
    ...new Map(
      [...wiki, ...lexical].map((chunk) => [chunk.id, chunk]),
    ).values(),
  ].slice(0, OPENAI_CANDIDATE_LIMIT);
}

function cosine(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
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
