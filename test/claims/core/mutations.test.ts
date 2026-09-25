import { describe, expect, test } from "vitest";
import { ClaimSessionError } from "../../../src/claims/core/errors.ts";
import {
  applyClaimOperations,
  cloneClaims,
} from "../../../src/claims/core/mutations.ts";
import type {
  Claim,
  EvidenceResolver,
  ResolvedEvidence,
} from "../../../src/claims/core/types.ts";

/**
 * Creates resolver-owned in-memory evidence.
 *
 * @param resource - Canonical memory resource.
 * @param version - Resolver-owned version.
 * @returns Resolved memory evidence.
 */
function memoryEvidence(resource: string, version: string): ResolvedEvidence {
  return {
    evidence: { resource, version },
    content: `memory content for ${resource}`,
  };
}

/**
 * Creates a generic non-repository evidence resolver.
 *
 * @param outcomes - Resolution outcomes keyed by proposed resource.
 * @param calls - Optional ordered resolution call log.
 * @returns Generic memory evidence resolver.
 */
function createMemoryResolver(
  outcomes: ReadonlyMap<string, ResolvedEvidence | null | Error>,
  calls?: string[],
): EvidenceResolver {
  return {
    resolve(resource: string): Promise<ResolvedEvidence | null> {
      calls?.push(resource);
      const outcome = outcomes.get(resource);
      if (outcome instanceof Error) {
        return Promise.reject(outcome);
      }
      return Promise.resolve(outcome ?? null);
    },
  };
}

/**
 * Existing non-page claim fixture used by mutation tests.
 */
const EXISTING_CLAIMS: Claim[] = [
  {
    id: "claim_existing",
    statement: "The reminder is scheduled for Tuesday.",
    evidence: [
      {
        resource: "memory://reminders/weekly",
        version: "revision:1",
      },
    ],
  },
];

describe("applyClaimOperations", () => {
  test("adds generic claims with OpenWiki-owned IDs and resolver-owned evidence", async () => {
    const resolver = createMemoryResolver(
      new Map([
        [
          "memory://draft/reminder",
          memoryEvidence("memory://reminders/monthly", "revision:7"),
        ],
      ]),
    );

    const result = await applyClaimOperations({
      claims: [],
      operations: [
        {
          op: "add",
          statement: "  The reminder repeats monthly.  ",
          evidence: [{ resource: "memory://draft/reminder" }],
        },
      ],
      resolver,
      createClaimId: () => "claim_generated",
    });

    expect(result).toEqual([
      {
        id: "claim_generated",
        statement: "The reminder repeats monthly.",
        evidence: [
          {
            resource: "memory://reminders/monthly",
            version: "revision:7",
          },
        ],
      },
    ]);
  });

  test("supports partial updates, confirmations, and ordered retractions", async () => {
    const resolver = createMemoryResolver(
      new Map([
        [
          "memory://reminders/weekly",
          memoryEvidence("memory://reminders/weekly", "revision:2"),
        ],
        [
          "memory://reminders/monthly",
          memoryEvidence("memory://reminders/monthly", "revision:1"),
        ],
      ]),
    );
    const starting = [
      ...cloneClaims(EXISTING_CLAIMS),
      {
        id: "claim_remove",
        statement: "Remove me.",
        evidence: [{ resource: "memory://remove", version: "revision:1" }],
      },
    ];

    const result = await applyClaimOperations({
      claims: starting,
      operations: [
        {
          op: "update",
          id: "claim_existing",
          statement: "The reminder is scheduled for Wednesday.",
          evidence: [{ resource: "memory://reminders/weekly" }],
        },
        { op: "retract", id: "claim_remove" },
        {
          op: "add",
          statement: "A monthly reminder also exists.",
          evidence: [{ resource: "memory://reminders/monthly" }],
        },
      ],
      resolver,
      createClaimId: () => "claim_monthly",
    });

    expect(result.map((claim) => claim.id)).toEqual([
      "claim_existing",
      "claim_monthly",
    ]);
    expect(result[0]?.evidence[0]?.version).toBe("revision:2");
  });

  test("confirm retains the statement and refreshes existing evidence", async () => {
    const resource = "memory://reminders/weekly";
    const result = await applyClaimOperations({
      claims: EXISTING_CLAIMS,
      operations: [{ op: "confirm", id: "claim_existing" }],
      resolver: createMemoryResolver(
        new Map([[resource, memoryEvidence(resource, "revision:2")]]),
      ),
    });

    expect(result[0]).toEqual({
      ...EXISTING_CLAIMS[0],
      evidence: [{ resource, version: "revision:2" }],
    });
  });

  test("passes the prior opaque version when refreshing existing evidence", async () => {
    const calls: Array<{ resource: string; previousVersion?: string }> = [];
    const resource = "memory://reminders/weekly";
    const resolver: EvidenceResolver = {
      resolve(resourceInput, previousVersion) {
        calls.push({ resource: resourceInput, previousVersion });
        return Promise.resolve(memoryEvidence(resourceInput, "revision:2"));
      },
    };

    await applyClaimOperations({
      claims: EXISTING_CLAIMS,
      operations: [{ op: "confirm", id: "claim_existing" }],
      resolver,
    });

    expect(calls).toEqual([{ resource, previousVersion: "revision:1" }]);
  });

  test("statement-only updates retain resources and refresh their versions", async () => {
    const resource = "memory://reminders/weekly";
    const result = await applyClaimOperations({
      claims: EXISTING_CLAIMS,
      operations: [
        {
          op: "update",
          id: "claim_existing",
          statement: "The reminder is scheduled for Wednesday.",
        },
      ],
      resolver: createMemoryResolver(
        new Map([[resource, memoryEvidence(resource, "revision:3")]]),
      ),
    });

    expect(result[0]?.statement).toBe(
      "The reminder is scheduled for Wednesday.",
    );
    expect(result[0]?.evidence).toEqual([{ resource, version: "revision:3" }]);
  });

  test("resolves shared evidence once per mutation batch", async () => {
    const resource = "memory://shared";
    const calls: string[] = [];

    await applyClaimOperations({
      claims: [],
      operations: [
        {
          op: "add",
          statement: "The first fact is supported.",
          evidence: [{ resource }],
        },
        {
          op: "add",
          statement: "The second fact is supported.",
          evidence: [{ resource }],
        },
      ],
      resolver: createMemoryResolver(
        new Map([[resource, memoryEvidence(resource, "revision:1")]]),
        calls,
      ),
      createClaimId: (() => {
        let next = 0;
        return () => `claim_${++next}`;
      })(),
    });

    expect(calls).toEqual([resource]);
  });

  test("returns structural clones across ownership boundaries", async () => {
    const original = cloneClaims(EXISTING_CLAIMS);
    const cloned = cloneClaims(original);
    cloned[0].statement = "Changed";
    cloned[0].evidence[0].version = "changed";

    expect(original).toEqual(EXISTING_CLAIMS);

    const result = await applyClaimOperations({
      claims: original,
      operations: [{ op: "retract", id: "claim_existing" }],
      resolver: createMemoryResolver(new Map()),
    });

    expect(result).toEqual([]);
    expect(original).toEqual(EXISTING_CLAIMS);
  });

  test.each([
    ["unknown IDs", [{ op: "retract", id: "claim_missing" }] as const],
    [
      "duplicate targets",
      [
        { op: "confirm", id: "claim_existing" },
        { op: "retract", id: "claim_existing" },
      ] as const,
    ],
    ["empty operations", [] as const],
  ])("rejects %s without mutating input", async (_name, operations) => {
    const original = cloneClaims(EXISTING_CLAIMS);

    await expect(
      applyClaimOperations({
        claims: original,
        operations: [...operations],
        resolver: createMemoryResolver(new Map()),
      }),
    ).rejects.toThrow(ClaimSessionError);
    expect(original).toEqual(EXISTING_CLAIMS);
  });

  test("rejects unresolved evidence atomically after earlier resolutions", async () => {
    const first = "memory://available";
    const second = "memory://missing";
    const original = cloneClaims(EXISTING_CLAIMS);
    const calls: string[] = [];

    await expect(
      applyClaimOperations({
        claims: original,
        operations: [
          {
            op: "add",
            statement: "Unavailable fact.",
            evidence: [{ resource: first }, { resource: second }],
          },
        ],
        resolver: createMemoryResolver(
          new Map([[first, memoryEvidence(first, "revision:1")]]),
          calls,
        ),
      }),
    ).rejects.toThrow("Evidence does not resolve");
    expect(calls).toEqual([first, second]);
    expect(original).toEqual(EXISTING_CLAIMS);
  });

  test("propagates resolver failures without mutating input", async () => {
    const resource = "memory://broken";
    const failure = new Error("memory service unavailable");
    const original = cloneClaims(EXISTING_CLAIMS);

    await expect(
      applyClaimOperations({
        claims: original,
        operations: [
          {
            op: "add",
            statement: "Broken fact.",
            evidence: [{ resource }],
          },
        ],
        resolver: createMemoryResolver(new Map([[resource, failure]])),
      }),
    ).rejects.toBe(failure);
    expect(original).toEqual(EXISTING_CLAIMS);
  });

  test("rejects proposed and canonical duplicate evidence", async () => {
    const alias = "memory://alias";
    const canonical = "memory://canonical";
    const resolver = createMemoryResolver(
      new Map([
        [alias, memoryEvidence(canonical, "revision:1")],
        [canonical, memoryEvidence(canonical, "revision:1")],
      ]),
    );

    await expect(
      applyClaimOperations({
        claims: [],
        operations: [
          {
            op: "add",
            statement: "Duplicate proposed evidence.",
            evidence: [{ resource: alias }, { resource: alias }],
          },
        ],
        resolver,
      }),
    ).rejects.toThrow(ClaimSessionError);
    await expect(
      applyClaimOperations({
        claims: [],
        operations: [
          {
            op: "add",
            statement: "Duplicate canonical evidence.",
            evidence: [{ resource: alias }, { resource: canonical }],
          },
        ],
        resolver,
      }),
    ).rejects.toThrow("resolves to duplicate resource");
  });

  test("never reuses deleted or colliding IDs", async () => {
    const resource = "memory://replacement";
    const generated = ["claim_existing", "claim_existing", "claim_new"];

    const result = await applyClaimOperations({
      claims: EXISTING_CLAIMS,
      operations: [
        { op: "retract", id: "claim_existing" },
        {
          op: "add",
          statement: "Replacement fact.",
          evidence: [{ resource }],
        },
      ],
      resolver: createMemoryResolver(
        new Map([[resource, memoryEvidence(resource, "revision:1")]]),
      ),
      createClaimId: () => generated.shift() ?? "claim_fallback",
    });

    expect(result[0]?.id).toBe("claim_new");
  });

  test("rejects invalid starting state and generated IDs", async () => {
    const calls: string[] = [];
    const invalid: Claim[] = [
      {
        id: "claim_invalid",
        statement: "Invalid.",
        evidence: [],
      },
    ];

    await expect(
      applyClaimOperations({
        claims: invalid,
        operations: [{ op: "retract", id: "claim_invalid" }],
        resolver: createMemoryResolver(new Map(), calls),
      }),
    ).rejects.toThrow(ClaimSessionError);
    await expect(
      applyClaimOperations({
        claims: [],
        operations: [
          {
            op: "add",
            statement: "Fact.",
            evidence: [{ resource: "memory://fact" }],
          },
        ],
        resolver: createMemoryResolver(
          new Map([
            ["memory://fact", memoryEvidence("memory://fact", "revision:1")],
          ]),
        ),
        createClaimId: () => " ",
      }),
    ).rejects.toThrow("Generated claim id cannot be empty");
    expect(calls).toEqual([]);
  });

  test("rejects empty partial updates", async () => {
    await expect(
      applyClaimOperations({
        claims: EXISTING_CLAIMS,
        operations: [{ op: "update", id: "claim_existing" } as never],
        resolver: createMemoryResolver(new Map()),
      }),
    ).rejects.toThrow("requires a statement or evidence");
  });
});
