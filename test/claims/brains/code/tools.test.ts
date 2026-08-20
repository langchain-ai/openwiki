import type { StructuredToolInterface } from "@langchain/core/tools";
import { describe, expect, test, vi } from "vitest";
import { EvidenceResolutionError } from "../../../../src/claims/core/errors.ts";
import { CLAIMS_SUBSTANCE_GUIDANCE } from "../../../../src/claims/guidance.ts";
import type {
  EvidenceResolver,
  ResolvedEvidence,
} from "../../../../src/claims/core/types.ts";
import { ClaimSession } from "../../../../src/claims/brains/code/session.ts";
import {
  createClaimsDeleteFileTool,
  createClaimsTools,
} from "../../../../src/claims/brains/code/tools.ts";

const PAGE = "/openwiki/page.md";
const RESOURCE = "memory://feature";

function resolved(version = "revision:2"): ResolvedEvidence {
  return {
    evidence: { resource: RESOURCE, version },
    content: "feature content",
  };
}

function createSession(options?: {
  resolver?: EvidenceResolver;
  issue?: boolean;
  createClaimId?: () => string;
}): ClaimSession {
  return new ClaimSession({
    resolver: options?.resolver ?? {
      resolve: () => Promise.resolve(resolved()),
    },
    persisted: new Map([
      [
        PAGE,
        {
          schemaVersion: 1,
          pageVersion: `sha256:${"a".repeat(64)}`,
          claims: [
            {
              id: "claim_existing",
              statement: "The feature exists.",
              evidence: [{ resource: RESOURCE, version: "revision:1" }],
            },
          ],
        },
      ],
    ]),
    issues: options?.issue
      ? [
          {
            page: PAGE,
            kind: "stale",
            claimId: "claim_existing",
            resources: [RESOURCE],
          },
        ]
      : [],
    orphanPages: [],
    createClaimId: options?.createClaimId,
  });
}

function getTool(
  tools: StructuredToolInterface[],
  name: string,
): StructuredToolInterface {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

function parse(output: unknown): Record<string, unknown> {
  return JSON.parse(String(output)) as Record<string, unknown>;
}

/** Shape `resolve_claims` returns: successes per page, failures per page. */
interface ResolveToolOutput {
  pages?: { page: string }[];
  failed?: { page: string; error: string; retryable: boolean }[];
  error?: string;
  retryable?: boolean;
}

function parseResolve(output: unknown): ResolveToolOutput {
  return JSON.parse(String(output)) as ResolveToolOutput;
}

describe("createClaimsTools", () => {
  test("exposes the compact resolve and inspect API", () => {
    const tools = createClaimsTools(createSession());
    expect(tools.map(({ name }) => name)).toEqual([
      "resolve_claims",
      "inspect_claims",
    ]);
    const resolveDescription = getTool(tools, "resolve_claims").description;
    // The substance standard is carried verbatim rather than paraphrased, so a
    // reworded guidance constant cannot silently leave this description behind.
    expect(resolveDescription).toContain(CLAIMS_SUBSTANCE_GUIDANCE);
    // What the description owns on its own: this tool's operational contract.
    expect(resolveDescription).toContain("confirm");
    expect(resolveDescription).toContain("repository evidence only");
    expect(resolveDescription).toContain("repo://path#L10-L24");
    expect(resolveDescription).toContain(
      "leave LangSmith-only facts unclaimed",
    );
    expect(getTool(tools, "inspect_claims").description).toContain(
      "without creating a write obligation",
    );
    expect(getTool(tools, "inspect_claims").description).toContain("Pass ids");
    expect(getTool(tools, "inspect_claims").description).toContain(
      "Pass pages only as a fallback",
    );
    expect(getTool(tools, "inspect_claims").schema).not.toHaveProperty("oneOf");
  });

  test("returns only compact operation results and allocated IDs", async () => {
    const resolve = getTool(
      createClaimsTools(createSession({ createClaimId: () => "claim_new" })),
      "resolve_claims",
    );
    const output = parse(
      await resolve.invoke({
        pages: [
          {
            page: "page.md",
            operations: [
              {
                op: "add",
                statement: "The feature is configurable.",
                evidence: [{ resource: RESOURCE }],
              },
            ],
          },
        ],
      }),
    );

    expect(output).toEqual({
      pages: [
        {
          page: PAGE,
          results: [{ op: "add", id: "claim_new" }],
        },
      ],
    });
    expect(JSON.stringify(output)).not.toContain("revision:2");
    expect(output).not.toHaveProperty("claims");
  });

  test("resolves independent pages in one call", async () => {
    const session = createSession({ createClaimId: () => "claim_new" });
    const resolve = getTool(createClaimsTools(session), "resolve_claims");

    expect(
      parse(
        await resolve.invoke({
          pages: [
            {
              page: PAGE,
              operations: [{ op: "confirm", id: "claim_existing" }],
            },
            {
              page: "other.md",
              operations: [
                {
                  op: "add",
                  statement: "The other feature exists.",
                  evidence: [{ resource: RESOURCE }],
                },
              ],
            },
          ],
        }),
      ),
    ).toEqual({
      pages: [
        {
          page: PAGE,
          results: [{ op: "confirm", id: "claim_existing" }],
        },
        {
          page: "/openwiki/other.md",
          results: [{ op: "add", id: "claim_new" }],
        },
      ],
    });
  });

  test("inspects selected claims without exposing opaque versions", async () => {
    const inspect = getTool(
      createClaimsTools(createSession({ issue: true })),
      "inspect_claims",
    );
    const output = parse(
      await inspect.invoke({
        ids: ["claim_existing"],
      }),
    );

    expect(output).toEqual({
      pages: [
        {
          page: PAGE,
          claims: [
            {
              id: "claim_existing",
              statement: "The feature exists.",
              evidence: [RESOURCE],
              issue: { kind: "stale", resources: [RESOURCE] },
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(output)).not.toContain("revision:1");
  });

  test("confirm refreshes evidence and clears the lazy issue", async () => {
    const session = createSession({ issue: true });
    const tools = createClaimsTools(session);
    const resolve = getTool(tools, "resolve_claims");
    const inspect = getTool(tools, "inspect_claims");

    expect(
      parse(
        await resolve.invoke({
          pages: [
            {
              page: PAGE,
              operations: [{ op: "confirm", id: "claim_existing" }],
            },
          ],
        }),
      ),
    ).toEqual({
      pages: [
        {
          page: PAGE,
          results: [{ op: "confirm", id: "claim_existing" }],
        },
      ],
    });
    const inspected = parse(await inspect.invoke({ ids: ["claim_existing"] }));
    expect(JSON.stringify(inspected)).not.toContain("issue");
  });

  test("inspects complete claim sets for selected pages", async () => {
    const inspect = getTool(
      createClaimsTools(createSession()),
      "inspect_claims",
    );

    expect(parse(await inspect.invoke({ pages: ["page.md"] }))).toEqual({
      pages: [
        {
          page: PAGE,
          claims: [
            {
              id: "claim_existing",
              statement: "The feature exists.",
              evidence: [RESOURCE],
            },
          ],
        },
      ],
    });
  });

  test.each([
    ["neither selector", {}],
    ["both selectors", { ids: ["claim_existing"], pages: ["page.md"] }],
  ])("returns retry guidance for %s", async (_case, input) => {
    const inspect = getTool(
      createClaimsTools(createSession()),
      "inspect_claims",
    );
    expect(parse(await inspect.invoke(input))).toEqual({
      error: "input: Pass exactly one of ids or pages",
      retryable: true,
    });
  });

  test("supports statement-only partial updates", async () => {
    const session = createSession();
    const resolve = getTool(createClaimsTools(session), "resolve_claims");
    await resolve.invoke({
      pages: [
        {
          page: PAGE,
          operations: [
            {
              op: "update",
              id: "claim_existing",
              statement: "The feature remains available.",
            },
          ],
        },
      ],
    });
    expect(session.inspectClaims(PAGE)[0]?.statement).toBe(
      "The feature remains available.",
    );
  });

  test.each([
    [
      "unknown claim",
      {
        pages: [
          {
            page: PAGE,
            operations: [{ op: "retract", id: "claim_missing" }],
          },
        ],
      },
    ],
    [
      "invalid page",
      {
        pages: [
          {
            page: "../outside.md",
            operations: [{ op: "confirm", id: "claim_existing" }],
          },
        ],
      },
    ],
  ])("returns retryable errors for %s", async (_case, input) => {
    const resolve = getTool(
      createClaimsTools(createSession()),
      "resolve_claims",
    );
    const output = parseResolve(await resolve.invoke(input));
    // A page path that will not normalize fails the whole call, because there is
    // no page to attribute it to. Anything that fails while resolving one page's
    // operations is reported against that page, so the other pages in the call
    // keep their results and the model can retry just the one.
    expect(
      output.retryable === true || output.failed?.[0]?.retryable === true,
    ).toBe(true);
  });

  test("rejects an empty partial update through the public schema", async () => {
    const resolve = getTool(
      createClaimsTools(createSession()),
      "resolve_claims",
    );
    await expect(
      resolve.invoke({
        pages: [
          {
            page: PAGE,
            operations: [{ op: "update", id: "claim_existing" }],
          },
        ],
      }),
    ).rejects.toThrow("did not match expected schema");
  });

  test("returns unresolved evidence as a retryable confirmation error", async () => {
    const resolve = getTool(
      createClaimsTools(
        createSession({ resolver: { resolve: () => Promise.resolve(null) } }),
      ),
      "resolve_claims",
    );
    const output = parseResolve(
      await resolve.invoke({
        pages: [
          {
            page: PAGE,
            operations: [{ op: "confirm", id: "claim_existing" }],
          },
        ],
      }),
    );
    expect(output.pages).toEqual([]);
    expect(output.failed).toHaveLength(1);
    expect(output.failed?.[0]).toMatchObject({ page: PAGE, retryable: true });
    expect(output.failed?.[0]?.error).toContain("Evidence does not resolve");
  });

  test("one page's evidence failure leaves the other pages resolved", async () => {
    // The batch-wide error this replaced is why a graded coordinator abandoned
    // batching and called the tool once per page, 108 times in one run: a single
    // failure hid every success, so per-page calls were the only way to learn
    // which page was at fault.
    const other = "/openwiki/other.md";
    const session = createSession({
      resolver: {
        resolve: (resource: string) =>
          Promise.resolve(
            resource.includes("missing")
              ? null
              : { evidence: { resource, version: "revision:2" }, content: "c" },
          ),
      },
    });
    const resolve = getTool(createClaimsTools(session), "resolve_claims");
    const output = parseResolve(
      await resolve.invoke({
        pages: [
          {
            page: PAGE,
            operations: [
              {
                op: "add",
                statement: "The resolvable page states one fact.",
                evidence: [{ resource: "repo://src/present.ts" }],
              },
            ],
          },
          {
            page: other,
            operations: [
              {
                op: "add",
                statement: "This one cites evidence that does not resolve.",
                evidence: [{ resource: "repo://src/missing.ts" }],
              },
            ],
          },
        ],
      }),
    );
    expect(output.pages).toHaveLength(1);
    expect(output.pages?.[0]?.page).toBe(PAGE);
    expect(output.failed).toHaveLength(1);
    expect(output.failed?.[0]).toMatchObject({ page: other, retryable: true });
    // The seeded claim plus the one this call added: the successful page's
    // mutation applied even though its neighbour in the same call failed.
    expect(session.inspectClaims(PAGE)).toHaveLength(2);
  });

  test("keeps applied pages when a later page fails operationally", async () => {
    // Throwing would discard `pages`, whose mutations already applied. A total
    // failure reported over applied state is the same lie the batch-wide error
    // told, so a partial failure is reported instead - not retryable, because
    // replaying it will not produce a different answer.
    const other = "/openwiki/other.md";
    const session = createSession({
      resolver: {
        resolve: (resource: string) =>
          resource.includes("broken")
            ? Promise.reject(
                new EvidenceResolutionError("resolver unavailable"),
              )
            : Promise.resolve({
                evidence: { resource, version: "revision:2" },
                content: "c",
              }),
      },
    });
    const resolve = getTool(createClaimsTools(session), "resolve_claims");
    const output = parseResolve(
      await resolve.invoke({
        pages: [
          {
            page: PAGE,
            operations: [
              {
                op: "add",
                statement: "This page resolved before the resolver went down.",
                evidence: [{ resource: "repo://src/fine.ts" }],
              },
            ],
          },
          {
            page: other,
            operations: [
              {
                op: "add",
                statement: "This one hit the failure.",
                evidence: [{ resource: "repo://src/broken.ts" }],
              },
            ],
          },
        ],
      }),
    );
    expect(output.pages).toHaveLength(1);
    expect(output.failed?.[0]).toMatchObject({ page: other, retryable: false });
    expect(session.inspectClaims(PAGE)).toHaveLength(2);
  });

  test("does not hide operational resolver failures", async () => {
    const failure = new EvidenceResolutionError("resolver unavailable");
    const resolve = getTool(
      createClaimsTools(
        createSession({ resolver: { resolve: () => Promise.reject(failure) } }),
      ),
      "resolve_claims",
    );
    await expect(
      resolve.invoke({
        pages: [
          {
            page: PAGE,
            operations: [{ op: "confirm", id: "claim_existing" }],
          },
        ],
      }),
    ).rejects.toBe(failure);
  });
});

describe("createClaimsDeleteFileTool", () => {
  test("deletes a page without inspecting or retracting its claims", async () => {
    const session = createSession();
    const recordDeletion = vi.spyOn(session, "recordDeletion");
    const backend = { delete: vi.fn(() => Promise.resolve({ path: PAGE })) };
    const tool = createClaimsDeleteFileTool(session, backend);

    expect(parse(await tool.invoke({ file_path: "page.md" }))).toEqual({
      deleted: PAGE,
    });
    expect(backend.delete).toHaveBeenCalledWith(PAGE);
    expect(recordDeletion).toHaveBeenCalledWith(PAGE);
  });

  test("does not record a deletion refused by the backend", async () => {
    const session = createSession();
    const recordDeletion = vi.spyOn(session, "recordDeletion");
    const tool = createClaimsDeleteFileTool(session, {
      delete: () => Promise.resolve({ error: "permission denied" }),
    });

    expect(parse(await tool.invoke({ file_path: PAGE }))).toEqual({
      error: "permission denied",
    });
    expect(recordDeletion).not.toHaveBeenCalled();
  });

  test("deletes a reserved page without Claims bookkeeping", async () => {
    const session = createSession();
    const recordDeletion = vi.spyOn(session, "recordDeletion");
    const page = "/openwiki/_plan.md";
    const backend = { delete: vi.fn(() => Promise.resolve({ path: page })) };
    const tool = createClaimsDeleteFileTool(session, backend);

    expect(parse(await tool.invoke({ file_path: "_plan.md" }))).toEqual({
      deleted: page,
    });
    expect(backend.delete).toHaveBeenCalledWith(page);
    expect(recordDeletion).not.toHaveBeenCalled();
  });

  test("returns invalid deletion paths as retryable input errors", async () => {
    const tool = createClaimsDeleteFileTool(createSession(), {
      delete: () => Promise.resolve({ path: PAGE }),
    });
    expect(
      parse(await tool.invoke({ file_path: "../outside.md" })),
    ).toMatchObject({ retryable: true });
  });
});
