import { describe, expect, test } from "vitest";
import {
  createOpenWikiPlanLedgerMiddleware,
  renderPlanMarkdown,
  advisoryProblems,
  blockingProblems,
  validateEntry,
  validatePlanShape,
} from "../../src/agent/plan-ledger.ts";
import {
  canonicalWikiPage,
  createPlanStore,
  missingEvidence,
} from "../../src/agent/plan-store.ts";
import { findUncoveredDirectories } from "../../src/agent/repo-inventory.ts";
import { createQaGate } from "../../src/agent/wiki-verification.ts";

const TREE = ["/", "/smith-go", "/smith-backend"];

/** A page carrying every piece of evidence an author needs. */
// The default edge points at the page itself: these tests are not about edge
// semantics, and a self-reference always resolves against the same plan.
const page = (
  path: string,
  edges: { page: string; relationship: string }[] = [
    { page: path, relationship: "self" },
  ],
) => ({
  path,
  responsibility: "Owns the thing",
  entrypoint: "main.go#main",
  sources: ["smith-go/main.go#main"],
  tests: ["smith-go/main_test.go — make test-dir DIR=."],
  edges,
});

describe("plan validation", () => {
  test("rejects one bad entry without discarding the others", () => {
    // Submitting whole plans meant any single error discarded forty pages of
    // evidence, and a coordinator that hit five rejections stopped trying:
    // one run collapsed to a root entry, another deferred 37 of 38 areas to
    // one page and authored three.
    expect(
      validateEntry(
        {
          disposition: "document",
          directory: "/invented",
          pages: [page("openwiki/a.md")],
        },
        TREE,
      ).join(" "),
    ).toContain("not a directory list_repository_directories returned");
    expect(
      validateEntry(
        {
          disposition: "document",
          directory: "/smith-go",
          pages: [{ ...page("openwiki/a.md"), tests: [] }],
        },
        TREE,
      ).join(" "),
    ).toContain("missing tests");
    expect(
      validateEntry(
        {
          disposition: "document",
          directory: "/smith-go",
          pages: [page("openwiki/a.md")],
        },
        TREE,
      ),
    ).toEqual([]);
  });

  test("the root entry owns its own files, not the whole repository", () => {
    // The root's descendants are every rooted path. Building its prefix by
    // concatenation gave "//", which matched nothing, so the root subtracted
    // none of its children and was told a repository's whole file count.
    const tree = ["/", "/svc", "/lib"];
    const entries = [
      {
        disposition: "document" as const,
        directory: "/",
        pages: [page("openwiki/quickstart.md")],
      },
      {
        disposition: "document" as const,
        directory: "/svc",
        pages: [page("openwiki/svc.md")],
      },
      {
        disposition: "document" as const,
        directory: "/lib",
        pages: [page("openwiki/lib.md")],
      },
    ];
    // 9000 files in the tree, all but 12 of them claimed by /svc and /lib.
    const counts = new Map([
      ["/", 9000],
      ["/svc", 6000],
      ["/lib", 2988],
    ]);
    const problems = validatePlanShape(entries, [], tree, counts).join(" ");
    expect(problems).not.toContain("/ plans");
    // The areas that do own the volume are still asked for their pages.
    expect(problems).toContain("/svc plans 1 page(s) for 6000 source files");
  });

  test("an unlisted directory can still be excluded", () => {
    // The coverage walk runs live and to any depth while the listing is bounded
    // and read once, so it reports directories the listing never showed - one the
    // run itself created, or one below the listing depth. Refusing the exclusion
    // as well left the plan unable to answer a requirement it was held to, and
    // authoring never started.
    expect(
      validateEntry(
        {
          disposition: "exclude",
          directory: "/large_tool_results",
          reason: "the agent's own spill directory, not part of the repository",
        },
        TREE,
      ),
    ).toEqual([]);
    // A documented entry still has to name a directory the listing returned: a
    // typo there hides a real area behind a page that looks planned.
    expect(
      validateEntry(
        {
          disposition: "covered_by",
          directory: "/typo",
          page: "openwiki/a.md",
          reason: "x",
        },
        TREE,
      ).join(" "),
    ).toContain("not a directory list_repository_directories returned");
  });

  test("scales the page floor with documentable source, not with nesting", () => {
    const tree = ["/", "/svc", "/svc/a", "/svc/b", "/svc/c", "/svc/d"];
    const onePage = [
      {
        disposition: "document" as const,
        directory: "/svc",
        pages: [page("openwiki/svc.md")],
      },
      { disposition: "exclude" as const, directory: "/", reason: "root files" },
    ];

    // 40 files is under one page's worth, so one page satisfies it however many
    // directories that source is spread across.
    const light = new Map([["/svc", 40]]);
    expect(validatePlanShape(onePage, [], tree, light)).toEqual([]);

    // The identical directory shape holding 600 files needs six.
    const heavy = new Map([["/svc", 600]]);
    expect(validatePlanShape(onePage, [], tree, heavy).join(" ")).toContain(
      "plans 1 page(s) for 600 source files",
    );
    expect(validatePlanShape(onePage, [], tree, heavy).join(" ")).toContain(
      "needs at least 6",
    );

    // And it keeps applying past the second page - two pages is not a discharge.
    const twoPages = [
      {
        disposition: "document" as const,
        directory: "/svc",
        pages: [page("openwiki/svc.md"), page("openwiki/svc-two.md")],
      },
      { disposition: "exclude" as const, directory: "/", reason: "root files" },
    ];
    expect(validatePlanShape(twoPages, [], tree, heavy).join(" ")).toContain(
      "needs at least 6",
    );

    // Volume a deeper entry claims is that entry's problem, not this one's.
    const split = [
      ...twoPages,
      {
        disposition: "document" as const,
        directory: "/svc/a",
        pages: [page("openwiki/svc-a.md")],
      },
    ];
    const owned = new Map([
      ["/svc", 600],
      ["/svc/a", 550],
    ]);
    expect(validatePlanShape(split, [], tree, owned).join(" ")).not.toContain(
      "/svc plans",
    );
  });

  test("refuses one page standing in for a whole subtree", () => {
    // Breadth is what moves the score: 37 pages scored 0.263, 49 scored 0.331,
    // 71 scored 0.404 at identical page density. It collapses when an area
    // holding many directories plans a single page.
    const tree = [
      "/",
      "/big",
      "/big/a",
      "/big/b",
      "/big/c",
      "/big/d",
      "/small",
    ];
    const problems = validatePlanShape(
      [
        {
          disposition: "document",
          directory: "/big",
          pages: [page("openwiki/big.md")],
        },
        { disposition: "exclude", directory: "/small", reason: "fixtures" },
        { disposition: "exclude", directory: "/", reason: "root files" },
      ],
      [],
      tree,
      new Map([["/big", 400]]),
    ).join(" ");
    expect(problems).toContain("plans 1 page(s) for 400 source files");

    // A deeper entry claiming them is the other way to satisfy it.
    expect(
      validatePlanShape(
        [
          {
            disposition: "document",
            directory: "/big",
            pages: [page("openwiki/big.md")],
          },
          {
            disposition: "document",
            directory: "/big/a",
            pages: [page("openwiki/big-a.md")],
          },
          { disposition: "exclude", directory: "/big/b", reason: "fixtures" },
          { disposition: "exclude", directory: "/big/c", reason: "fixtures" },
          { disposition: "exclude", directory: "/big/d", reason: "fixtures" },
          { disposition: "exclude", directory: "/small", reason: "fixtures" },
          { disposition: "exclude", directory: "/", reason: "root files" },
        ],
        [],
        tree,
      ).join(" "),
    ).not.toContain("needs at least 2");
  });

  test("refuses a plan that defers most of the repository", () => {
    // Every cheap legal shape got used in turn; naming an area is not
    // documenting it.
    const many = Array.from({ length: 12 }, (_, i) => ({
      disposition: "covered_by" as const,
      directory: `/d${i}`,
      page: "openwiki/one.md",
      reason: "documented there",
    }));
    const problems = validatePlanShape(
      [
        {
          disposition: "document",
          directory: "/",
          pages: [page("openwiki/one.md")],
        },
        ...many,
      ],
      [],
    ).join(" ");
    expect(problems).toContain("of 13 areas are documented");
    expect(problems).toContain("cannot document that many");
  });

  test("accepts the three dispositions as peers", () => {
    expect(
      validatePlanShape(
        [
          {
            disposition: "document",
            directory: "/",
            pages: [page("openwiki/workspace.md")],
          },
          {
            disposition: "document",
            directory: "/smith-go",
            pages: [page("openwiki/go.md")],
          },
          {
            disposition: "covered_by",
            directory: "/smith-backend",
            page: "openwiki/go.md",
            reason: "Its API is documented on the Go page",
          },
        ],
        [],
      ),
    ).toEqual([]);
  });

  test("accepts an exclusion as a normal outcome", () => {
    // Not documenting a directory is a first-class answer. Making it awkward is
    // how a run ended up planning pages for /secrets.example and /test_data.
    expect(
      validatePlanShape(
        [
          {
            disposition: "document",
            directory: "/",
            pages: [page("openwiki/a.md")],
          },
          {
            disposition: "exclude",
            directory: "/smith-go",
            reason: "Fixtures only",
          },
          {
            disposition: "exclude",
            directory: "/smith-backend",
            reason: "Generated output",
          },
        ],
        [],
      ),
    ).toEqual([]);
  });

  test("rejects covered_by pointing at a page nothing documents", () => {
    // Otherwise covered_by is an exclusion wearing a more reassuring word.
    expect(
      validatePlanShape(
        [
          {
            disposition: "document",
            directory: "/",
            pages: [page("openwiki/a.md")],
          },
          {
            disposition: "covered_by",
            directory: "/smith-go",
            page: "openwiki/ghost.md",
            reason: "documented there",
          },
          {
            disposition: "exclude",
            directory: "/smith-backend",
            reason: "fixtures",
          },
        ],
        [],
      ).join(" "),
    ).toContain("which no entry documents");
  });

  test("rejects a directory nobody planned, and one that does not exist", () => {
    const problems = validatePlanShape(
      [
        {
          disposition: "document",
          directory: "/smith-go",
          pages: [page("openwiki/go.md")],
        },
        {
          disposition: "exclude",
          directory: "/invented",
          reason: "nope",
        },
      ],
      ["/", "/smith-backend"],
    ).join(" ");
    // The unknown-directory check is per entry now, so it is asserted there.
    expect(problems).toContain("covered by no entry");
  });

  test("rejects two entries owning one page, normalizing the prefix", () => {
    // The two spellings are one page, and two authors on it race on write_file.
    expect(
      validatePlanShape(
        [
          {
            disposition: "document",
            directory: "/",
            pages: [page("shared.md")],
          },
          {
            disposition: "document",
            directory: "/smith-go",
            pages: [page("openwiki/shared.md")],
          },
          {
            disposition: "exclude",
            directory: "/smith-backend",
            reason: "fixtures",
          },
        ],
        [],
      ).join(" "),
    ).toContain("owned by both");
  });

  test("renders the disposition and its counts", () => {
    const markdown = renderPlanMarkdown([
      {
        disposition: "document",
        directory: "/smith-go",
        pages: [page("openwiki/go.md")],
      },
      {
        disposition: "exclude",
        directory: "/test_data",
        reason: "Test fixtures",
      },
    ]);
    expect(markdown).toContain(
      "| Page | Responsibility | Entrypoint | Tests | Relates to |",
    );
    expect(markdown).toContain("1 documented, 0 covered elsewhere, 1 excluded");
  });

  test("rejects a page with no anchor, entrypoint, or focused test", () => {
    // An author sent without these writes what it can see, and what it cannot
    // see is what the grader asks for: boundary is absent 64% of the time and
    // validation 57%, and neither is derivable from the author's own subtree.
    expect(
      missingEvidence({
        path: "openwiki/a.md",
        responsibility: "",
        entrypoint: "",
        sources: [],
        tests: [],
        edges: [],
      }),
    ).toEqual([
      "sources",
      "entrypoint",
      "tests",
      "responsibility",
      "at least one edge - what this depends on, or what depends on it",
    ]);
    expect(missingEvidence(page("openwiki/a.md"))).toEqual([]);
  });

  test("rejects an edge to a page nothing documents", () => {
    // Otherwise the author is told to link somewhere that will never exist.
    expect(
      validatePlanShape(
        [
          {
            disposition: "document",
            directory: "/",
            pages: [
              page("openwiki/a.md", [
                { page: "openwiki/ghost.md", relationship: "calls it" },
              ]),
            ],
          },
          {
            disposition: "exclude",
            directory: "/smith-go",
            reason: "fixtures",
          },
          {
            disposition: "exclude",
            directory: "/smith-backend",
            reason: "fixtures",
          },
        ],
        [],
      ).join(" "),
    ).toContain("edge to openwiki/ghost.md, which no entry documents");
  });

  test("collapses every spelling of a page to one canonical path", () => {
    // These four were all in one run, and each boundary normalized differently
    // or not at all: the plan stored the extensionless form, the brief told the
    // author to write the .md file, and a count read on the un-suffixed path
    // threw and discarded a completed pool of 57 authors.
    for (const spelling of [
      "architecture/overview",
      "architecture/overview.md",
      "openwiki/architecture/overview.md",
      "/openwiki/architecture/overview.md",
    ]) {
      expect(canonicalWikiPage(spelling)).toBe(
        "/openwiki/architecture/overview.md",
      );
    }
  });
});

describe("coverage walk", () => {
  // A repository nested deeper than any display bound, to prove the check is
  // not limited by one: /deep/a/b/c/svc sits at depth 5.
  const nested = {
    ls: (dirPath: string) => {
      const clean = dirPath.replace(/\/+$/u, "") || "/";
      const tree: Record<string, string[]> = {
        "/": ["deep", "flat", "tests"],
        "/deep": ["a"],
        "/deep/a": ["b"],
        "/deep/a/b": ["c"],
        "/deep/a/b/c": ["svc"],
        "/deep/a/b/c/svc": [],
        "/flat": [],
      };
      return Promise.resolve({
        files: (tree[clean] ?? []).map((name) => ({
          path: clean === "/" ? name : `${clean}/${name}`,
          is_dir: true,
        })),
      });
    },
  };

  test("an entry covers everything beneath it, at any depth", async () => {
    // /deep covers /deep/a/b/c/svc without naming it, which is why depth costs
    // the plan nothing: coverage is inherited.
    expect(
      await findUncoveredDirectories(nested, ["/", "/deep", "/flat"]),
    ).toEqual([]);
  });

  test("an entry on the root covers only the root's own files", async () => {
    // It used to cover everything, which made the guarantee vacuous: a plan of
    // one root entry passed coverage on 964 directories and scored 0.230.
    expect(await findUncoveredDirectories(nested, ["/"])).toEqual([
      "/deep",
      "/flat",
    ]);
  });

  test("reports the highest uncovered directory, not its children", async () => {
    // One missed subtree should read as one problem.
    expect(await findUncoveredDirectories(nested, ["/flat"])).toEqual([
      "/",
      "/deep",
    ]);
  });

  test("still descends into a subtree that was partitioned", async () => {
    // /deep is covered, but a deeper entry means it was split, so something
    // inside it can still have been missed - here /deep/a/b.
    expect(
      await findUncoveredDirectories(nested, [
        "/",
        "/deep",
        "/deep/a/b/c",
        "/flat",
      ]),
    ).toEqual([]);
  });

  test("the root's own files need an entry of their own", async () => {
    // Nothing but "/" covers them, so omitting it is a real gap.
    expect(await findUncoveredDirectories(nested, ["/deep", "/flat"])).toEqual([
      "/",
    ]);
  });
});

/** Repository with one real directory, a test directory, and a wiki tree. */
function stubBackend(wikiFiles: string[]) {
  const written: Record<string, string> = {};
  return {
    written,
    ls: (dirPath: string) => {
      const clean = dirPath.replace(/\/+$/u, "") || "/";
      if (clean === "/") {
        return Promise.resolve({
          files: [
            { path: "smith-go", is_dir: true },
            { path: "tests", is_dir: true },
            { path: "node_modules", is_dir: true },
            { path: "README.md", is_dir: false },
          ],
        });
      }
      if (clean === "/smith-go") {
        return Promise.resolve({
          files: [{ path: "smith-go/api", is_dir: true }],
        });
      }
      if (clean === "/openwiki") {
        return Promise.resolve({
          files: wikiFiles.map((path) => ({ path, is_dir: false })),
        });
      }
      return Promise.resolve({ files: [] });
    },
    write: (filePath: string, content: string) => {
      written[filePath] = content;
      return Promise.resolve({});
    },
  };
}

function wire(
  backend: ReturnType<typeof stubBackend>,
  gate?: ReturnType<typeof createQaGate>,
) {
  const middleware = createOpenWikiPlanLedgerMiddleware(
    backend,
    createPlanStore(),
    gate,
  );
  const tools = Object.fromEntries(
    (
      middleware as {
        tools: { name: string; invoke: (i: unknown) => Promise<unknown> }[];
      }
    ).tools.map((t) => [t.name, t]),
  );
  const call = async (name: string, args: unknown = {}) =>
    JSON.parse(String(await tools[name].invoke(args))) as Record<
      string,
      unknown
    >;
  return { call };
}

describe("submit_plan", () => {
  test("accepts a plan covering every directory and renders the plan file", async () => {
    const backend = stubBackend([]);
    const { call } = wire(backend);
    const out = await call("submit_plan", {
      entries: [
        {
          disposition: "document",
          directory: "/",
          pages: [page("openwiki/workspace.md")],
        },
        {
          disposition: "document",
          directory: "/smith-go",
          pages: [page("openwiki/go/api.md")],
        },
      ],
    });
    expect(out.accepted).toBe(true);
    expect(out.plannedPages).toBe(2);
    expect(backend.written["/openwiki/_plan.md"]).toContain("| Page |");
  });

  test("records a partial plan and says what still blocks authoring", async () => {
    // Coverage is no longer a rejection: the plan is built up over calls, so an
    // incomplete plan is one in progress rather than one thrown away.
    const { call } = wire(stubBackend([]));
    const out = await call("submit_plan", {
      entries: [
        {
          disposition: "document",
          directory: "/smith-go",
          pages: [page("openwiki/go.md")],
        },
      ],
    });
    expect(out.accepted).toBe(true);
    expect(out.recorded).toBe(1);
    // Named for what it costs: this class stops authoring, the shortfall class does not.
    expect(String(out.blocking)).toContain("covered by no entry");
  });

  test("lists the directories a plan must cover", async () => {
    const { call } = wire(stubBackend([]));
    const out = await call("list_repository_directories");
    // tests/ and node_modules/ are excluded as subjects, not as evidence.
    expect(out.tree).toEqual(["/", "/smith-go", "/smith-go/api"]);
  });
});

describe("finalize_wiki", () => {
  test("refuses while a planned page is missing, and passes once written", async () => {
    // The 0.290 trial: 62 planned pages, 33 on disk, reported success.
    const missing = wire(stubBackend([]));
    await missing.call("submit_plan", {
      entries: [
        {
          disposition: "document",
          directory: "/",
          pages: [page("openwiki/a.md")],
        },
        { disposition: "exclude", directory: "/smith-go", reason: "fixtures" },
      ],
    });
    const blocked = await missing.call("finalize_wiki");
    expect(blocked.complete).toBe(false);
    expect(String(blocked.problems)).toContain("never written");

    const present = wire(stubBackend(["openwiki/a.md"]));
    await present.call("submit_plan", {
      entries: [
        {
          disposition: "document",
          directory: "/",
          pages: [page("openwiki/a.md")],
        },
        { disposition: "exclude", directory: "/smith-go", reason: "fixtures" },
      ],
    });
    expect((await present.call("finalize_wiki")).complete).toBe(true);
  });

  test("refuses completion when no plan exists", async () => {
    const { call } = wire(stubBackend([]));
    const out = await call("finalize_wiki");
    expect(out.complete).toBe(false);
    expect(String(out.problems)).toContain("submit_plan");
  });

  test("blocks on QA only in full mode, never on infrastructure or a spent budget", async () => {
    const finalize = async (gate: ReturnType<typeof createQaGate>) => {
      const { call } = wire(stubBackend(["openwiki/a.md"]), gate);
      await call("submit_plan", {
        entries: [
          {
            disposition: "document",
            directory: "/",
            pages: [page("openwiki/a.md")],
          },
          {
            disposition: "exclude",
            directory: "/smith-go",
            reason: "fixtures",
          },
        ],
      });
      return call("finalize_wiki");
    };

    expect(String((await finalize(createQaGate("full"))).problems)).toContain(
      "verify_wiki",
    );

    const failed = createQaGate("full");
    failed.status = "failed";
    failed.unresolved = ["Q-02"];
    expect(String((await finalize(failed)).problems)).toContain("Q-02");

    const passed = createQaGate("full");
    passed.status = "passed";
    expect((await finalize(passed)).complete).toBe(true);

    // off is a supported control arm, not a mode that cannot finish.
    expect((await finalize(createQaGate("off"))).complete).toBe(true);

    // A run that authored its pages is not thrown away because QA plumbing
    // broke, nor deadlocked by its own spent wave budget.
    const broken = createQaGate("full");
    broken.status = "infrastructure_error";
    expect((await finalize(broken)).complete).toBe(true);

    const spent = createQaGate("full");
    spent.status = "failed";
    spent.unresolved = ["Q-02"];
    spent.wavesRun = 2;
    expect((await finalize(spent)).complete).toBe(true);
  });
});

describe("submit_plan schema failures", () => {
  test("names the path and the nesting mistake instead of throwing", async () => {
    // The failure that froze a plan at 19 pages: an entry object nested inside
    // another entry's pages array, three times, each answered only with
    // "Error invoking tool submit_plan with kwargs {...}".
    const { call } = wire(stubBackend([]));
    const out = await call("submit_plan", {
      entries: [
        {
          disposition: "document",
          directory: "/",
          pages: [
            {
              path: "openwiki/a.md",
              responsibility: "r",
              entrypoint: "e",
              sources: ["s"],
              tests: ["t"],
              edges: [],
            },
            { disposition: "document", directory: "/smith-go", pages: [] },
          ],
        },
      ],
    });
    expect(out.accepted).toBe(false);
    const problems = (out.problems as string[]).join(" ");
    expect(problems).toContain("entries.0.pages.1");
    expect(problems).toContain("looks like an entry rather than a page");
  });

  test("reports a missing field by its path", async () => {
    const { call } = wire(stubBackend([]));
    const out = await call("submit_plan", {
      entries: [
        {
          disposition: "document",
          directory: "/",
          pages: [{ path: "openwiki/a.md", responsibility: "r" }],
        },
      ],
    });
    expect(out.accepted).toBe(false);
    expect((out.problems as string[]).join(" ")).toContain("entries.0.pages.0");
  });
});

describe("blocking versus advisory", () => {
  const tree = ["/", "/big", "/big/a", "/big/b", "/big/c", "/big/d"];
  const coarse: Parameters<typeof advisoryProblems>[0] = [
    {
      disposition: "document",
      directory: "/big",
      pages: [page("openwiki/big.md")],
    },
    { disposition: "exclude", directory: "/", reason: "root files" },
  ];

  test("a coarse plan is advised, not blocked", () => {
    // A nudge that can zero a run is not a nudge, so under-decomposition is
    // reported and the run proceeds.
    expect(
      advisoryProblems(coarse, tree, new Map([["/big", 300]])).join(" "),
    ).toContain("needs at least 3");
    expect(blockingProblems(coarse, [])).toEqual([]);
  });

  test("an uncovered directory still blocks", () => {
    // This one is not quality: a subtree nobody planned is invisible in the
    // result, so it has to stop authoring.
    expect(blockingProblems(coarse, ["/unplanned"]).join(" ")).toContain(
      "covered by no entry",
    );
  });
});
