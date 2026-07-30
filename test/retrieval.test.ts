import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  RETRIEVAL_TOOL_DEFINITIONS,
  SEARCH_SCOPES,
} from "../src/retrieval/mcp-tools.ts";
import { tokenize } from "../src/retrieval/ranking.ts";
import { RetrievalService } from "../src/retrieval/search-service.ts";

let root = "";
let repoRoot = "";
let wikiRoot = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "openwiki-retrieval-"));
  repoRoot = path.join(root, "repo");
  wikiRoot = path.join(root, "wiki");
  await Promise.all([
    mkdir(path.join(repoRoot, "packages/core/src/query"), { recursive: true }),
    mkdir(path.join(repoRoot, "packages/core/src/relation"), {
      recursive: true,
    }),
    mkdir(path.join(repoRoot, "packages/core/tests"), { recursive: true }),
    mkdir(path.join(repoRoot, "packages/publish/src"), { recursive: true }),
    mkdir(path.join(repoRoot, "packages/publish/tests"), { recursive: true }),
    mkdir(path.join(repoRoot, "secrets"), { recursive: true }),
    mkdir(path.join(wikiRoot, "architecture"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(wikiRoot, "quickstart.md"),
      `---
type: Quickstart
title: Koota quickstart
description: Routes query changes into runtime and package validation.
tags: [query, navigation]
---

# Quickstart

For query changes, follow the [runtime contract](architecture/runtime.md).
`,
    ),
    writeFile(
      path.join(wikiRoot, "architecture/runtime.md"),
      `---
type: Architecture
title: Query runtime and package contract
description: Connects predicate implementation to public exports and consumer tests.
tags: [query, package, runtime]
openwiki:
  roles: [architecture, testing, delivery]
  change_kinds: [public-api, lifecycle]
  source_paths:
    - packages/core/src/query/predicate.ts
    - packages/core/src/index.ts
    - packages/publish/src/index.ts
  symbols: [createPredicate]
  test_paths: [packages/core/tests/predicate.test.ts]
  invariants:
    - Predicate transitions must remain independent between instances.
  validation_commands: [pnpm -F core test predicate.test.ts]
---

# Query runtime

Implement predicates in \`packages/core/src/query/predicate.ts\`, export them from
\`packages/core/src/index.ts\`, mirror the public surface through
\`packages/publish/src/index.ts\`, and validate consumer imports in
\`packages/publish/tests/predicate.test.ts\`.

Unchanged predicate inputs must not emit a transition. Public exports must remain
available from the consumer package.

The [quickstart](../quickstart.md) routes adjacent changes here.
`,
    ),
    writeFile(
      path.join(repoRoot, "packages/core/src/query/predicate.ts"),
      "export const PUBLIC_PREDICATE_FACTORY = true;\nexport function createPredicate() { return true; }\n",
    ),
    writeFile(
      path.join(repoRoot, "packages/core/src/relation/relation-events.ts"),
      "export function removeRelationPair() { emitRelationEvent('remove'); }\nfunction emitRelationEvent(type: string) { return type; }\n",
    ),
    writeFile(
      path.join(repoRoot, "packages/core/src/index.ts"),
      "export { createPredicate } from './query/predicate';\n",
    ),
    writeFile(
      path.join(repoRoot, "packages/publish/src/index.ts"),
      "export { createPredicate } from '@koota/core';\n",
    ),
    writeFile(
      path.join(repoRoot, "packages/core/tests/predicate.test.ts"),
      "import { createPredicate } from '../src';\ndescribe('predicate lifecycle', () => {\n  test('tracks false-to-true transitions independently', () => createPredicate());\n});\n",
    ),
    writeFile(
      path.join(repoRoot, "packages/publish/tests/predicate.test.ts"),
      "import { createPredicate } from 'koota';\ndescribe('predicate lifecycle', () => {\n  test('tracks false-to-true transitions independently', () => createPredicate());\n});\n",
    ),
    writeFile(
      path.join(repoRoot, "AGENTS.md"),
      "Public API exports initialize register factory predicate relation removal tests.\n",
    ),
    writeFile(
      path.join(repoRoot, "packages/core/tests/unrelated.test.ts"),
      "test('generic public package initialization', () => true);\n",
    ),
    writeFile(
      path.join(repoRoot, ".env"),
      "SECRET_PREDICATE_SURFACE=never-index-this\n",
    ),
    writeFile(
      path.join(repoRoot, "secrets/credentials.json"),
      '{"note":"predicate consumer package"}\n',
    ),
  ]);
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

function service(): RetrievalService {
  return new RetrievalService({
    embeddingProvider: "local",
    repoRoot,
    wikiRoot,
  });
}

describe("OKF-aware repository retrieval", () => {
  test("exposes two concise workflow-oriented MCP tools", () => {
    expect(RETRIEVAL_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      "search",
      "change_surface",
    ]);
    expect(
      RETRIEVAL_TOOL_DEFINITIONS.every(
        (tool) =>
          tool.description.length >= 100 && tool.description.length < 300,
      ),
    ).toBe(true);
    expect(SEARCH_SCOPES).toEqual(["all", "wiki", "source_code", "tests"]);
  });

  test("automatically combines lexical, semantic, and OKF ranking", async () => {
    const retrieval = service();
    const exact = await retrieval.search("createPredicate", "source_code", 5);
    const concept = await retrieval.search("query navigation", "wiki", 5);
    const consumer = await retrieval.search(
      "consumer-facing package surface",
      "all",
      5,
    );

    expect(exact.results[0]?.path).toMatch(/predicate|index/u);
    expect(concept.results.map((hit) => hit.path)).toContain(
      "openwiki/architecture/runtime.md",
    );
    expect(
      consumer.results.some(
        (hit) =>
          hit.path.includes("runtime.md") || hit.path.includes("publish"),
      ),
    ).toBe(true);
  });

  test("matches snake and kebab compounds to camel-case source symbols", async () => {
    expect(tokenize("name_mapping HttpApi http-api")).toEqual([
      "name",
      "mapp",
      "http",
      "api",
      "http",
      "api",
    ]);
    await writeFile(
      path.join(repoRoot, "packages/core/src/query/NameMapping.ts"),
      "export class NameMapping {}\n",
    );

    const result = await service().search("name_mapping", "source_code", 5);

    expect(result.results[0]?.path).toContain("NameMapping.ts");
  });

  test("supports distinct wiki, source_code, and tests scopes", async () => {
    const retrieval = service();
    const source = await retrieval.search("createPredicate", "source_code", 10);
    const tests = await retrieval.search(
      "false-to-true independent predicate transition",
      "tests",
      10,
    );

    expect(source.results.every((hit) => !/test|spec/iu.test(hit.path))).toBe(
      true,
    );
    expect(tests.scope).toBe("tests");
    expect(tests.results.length).toBeGreaterThan(0);
    expect(tests.results.every((hit) => /test|spec/iu.test(hit.path))).toBe(
      true,
    );
    expect(tests.results.flatMap((hit) => hit.testNames ?? [])).toContain(
      "tracks false-to-true transitions independently",
    );
    expect(
      tests.results.filter((hit) => hit.path.endsWith("predicate.test.ts")),
    ).toHaveLength(1);
    expect(tests.results[0]).not.toHaveProperty("signals");
    expect(tests.results[0]).not.toHaveProperty("score");
  });

  test("clamps broad result requests to the public maximum", async () => {
    const result = await service().search(
      "predicate query public API",
      "all",
      50,
    );

    expect(result.results.length).toBeLessThanOrEqual(10);
  });

  test("change_surface returns a bounded metadata-routed task brief", async () => {
    const surface = await service().changeSurface(
      "add createPredicate query API and track relation removal events",
      7,
    );

    expect(surface.brief.ownership[0]?.path).toContain("predicate.ts");
    expect(surface.brief.ownership[0]?.reason).toContain("OpenWiki");
    expect(surface.brief.invariants.map((item) => item.text).join(" ")).toMatch(
      /independent|unchanged/iu,
    );
    expect(surface.brief.tests[0]?.path).toContain("predicate.test.ts");
    expect(surface.brief.tests[0]?.testNames).toContain(
      "tracks false-to-true transitions independently",
    );
    expect(surface.brief.delivery.length).toBeGreaterThan(0);
    expect(surface.brief.validation[0]?.command).toContain("pnpm -F core test");
    const evidence = [
      ...surface.brief.ownership,
      ...surface.brief.tests,
      ...surface.brief.delivery,
    ];
    expect(evidence.every((result) => result.path !== "AGENTS.md")).toBe(true);
    expect(surface.provenance.wikiConceptPaths).toContain(
      "openwiki/architecture/runtime.md",
    );
    expect(surface.provenance.metadataRoles).toContain("delivery");
    expect(surface.provenance.wikiReferencedSourcePaths).toContain(
      "packages/core/src/query/predicate.ts",
    );
    expect(JSON.stringify(surface).length).toBeLessThan(5_000);
  });

  test("change_surface reviews changed paths without treating gaps as requirements", async () => {
    const surface = await service().changeSurface(
      "add a public createPredicate API",
      6,
      ["packages/core/src/query/predicate.ts"],
    );

    expect(surface.provenance.changedPaths).toEqual([
      "packages/core/src/query/predicate.ts",
    ]);
    expect(surface.review?.some((item) => item.path.includes("index.ts"))).toBe(
      true,
    );
    expect(
      surface.review?.every((item) => item.reason.includes("verify")),
    ).toBe(true);
    await expect(
      service().changeSurface("public API", 6, ["../.env"]),
    ).rejects.toThrow("safe repository-relative paths");
  });

  test("weak wiki matches do not invent invariants or symbol ownership", async () => {
    await Promise.all([
      writeFile(
        path.join(wikiRoot, "architecture/noisy-routing.md"),
        `---
type: Architecture
title: Metadata routing notes
description: Notes about OKF metadata routing and retrieval briefs.
tags: [okf, metadata, retrieval]
---

# Metadata routing notes

Personal reminders should not be mixed into work commitments. The unrelated
example helper is \`wrongOwner\`.
`,
      ),
      writeFile(
        path.join(repoRoot, "packages/core/src/query/metadata-router.ts"),
        "export function routeOkfMetadataRetrievalBrief() { return true; }\n",
      ),
      writeFile(
        path.join(repoRoot, "packages/core/src/relation/wrong-owner.ts"),
        "export function wrongOwner() { return wrongOwner; }\n",
      ),
    ]);

    const surface = await service().changeSurface(
      "improve OKF metadata routing retrieval briefs",
    );

    expect(surface.brief.ownership[0]?.path).toContain("metadata-router.ts");
    expect(surface.brief.invariants).toEqual([]);
    expect(surface.brief.unknowns).toContain(
      "No explicit behavioral invariant was found in the wiki.",
    );
  });

  test("never indexes secret-like files", async () => {
    const result = await service().search(
      "never-index-this credentials",
      "all",
      50,
    );

    expect(
      result.results.every(
        (hit) => !/\.env|credentials\.json|secrets\//u.test(hit.path),
      ),
    ).toBe(true);
    expect(result.results.map((hit) => hit.snippet).join("\n")).not.toContain(
      "never-index-this",
    );
  });

  test("bounds query length", async () => {
    const retrieval = service();
    await expect(retrieval.search("x".repeat(501), "all", 5)).rejects.toThrow(
      "query must be",
    );
  });
});
