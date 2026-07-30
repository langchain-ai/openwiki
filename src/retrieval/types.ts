export type SearchScope = "all" | "source_code" | "tests" | "wiki";

export type IndexedScope = "source_code" | "wiki";

export type ChunkKind = "source" | "wiki-section";

export type DocumentRole =
  | "architecture"
  | "delivery"
  | "domain"
  | "integration"
  | "operations"
  | "reference"
  | "repository"
  | "testing"
  | "workflow";

export interface OpenWikiMetadata {
  changeKinds: string[];
  invariants: string[];
  roles: DocumentRole[];
  sourcePaths: string[];
  symbols: string[];
  testPaths: string[];
  validationCommands: string[];
}

export interface IndexedChunk {
  conceptPath?: string;
  description?: string;
  fields: string;
  heading?: string;
  id: string;
  kind: ChunkKind;
  lineEnd: number;
  lineStart: number;
  path: string;
  resource?: string;
  roles: DocumentRole[];
  scope: IndexedScope;
  tags: string[];
  testNames?: string[];
  text: string;
  title?: string;
  type?: string;
}

export interface OkfRelationship {
  context: string;
  kind: "dependency" | "delivery" | "lifecycle" | "navigation" | "related";
  target: string;
}

export interface OkfConcept {
  description?: string;
  incoming: Set<string>;
  metadata: OpenWikiMetadata;
  path: string;
  relationships: OkfRelationship[];
  resource?: string;
  roles: DocumentRole[];
  tags: string[];
  title: string;
  type: string;
}

export interface RepositoryCorpus {
  chunks: IndexedChunk[];
  concepts: Map<string, OkfConcept>;
}

export interface RankedHit {
  chunk: IndexedChunk;
  score: number;
  signals?: Record<string, number>;
}

export interface SearchResultItem {
  heading?: string;
  lineEnd: number;
  lineStart: number;
  path: string;
  snippet: string;
  tags?: string[];
  testNames?: string[];
  title?: string;
  type?: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResultItem[];
  scope: SearchScope;
}

export type SourceSurfaceCategory =
  | "consumer"
  | "exports"
  | "implementation"
  | "initialization"
  | "publish_generated"
  | "tests";

export type ChangeSurfaceCategory = SourceSurfaceCategory | "state_transitions";

export interface EvidenceReference {
  lineEnd: number;
  lineStart: number;
  path: string;
  reason: string;
  symbols?: string[];
  testNames?: string[];
  title?: string;
}

export interface ChangeSurfaceProvenance {
  changedPaths: string[];
  metadataRoles: DocumentRole[];
  wikiConceptPaths: string[];
  wikiReferencedSourcePaths: string[];
}

export interface BriefInvariant {
  lineEnd: number;
  lineStart: number;
  path: string;
  text: string;
}

export interface ValidationReference {
  command: string;
  path: string;
}

export interface CoverageReviewItem {
  path: string;
  reason: string;
}

export interface ChangeSurfaceBrief {
  delivery: EvidenceReference[];
  invariants: BriefInvariant[];
  ownership: EvidenceReference[];
  tests: EvidenceReference[];
  unknowns: string[];
  validation: ValidationReference[];
}

export interface ChangeSurfaceResponse {
  brief: ChangeSurfaceBrief;
  provenance: ChangeSurfaceProvenance;
  query: string;
  review?: CoverageReviewItem[];
}
