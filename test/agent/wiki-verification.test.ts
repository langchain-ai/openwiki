import { describe, expect, test } from "vitest";
import {
  createOpenWikiVerificationMiddleware,
  createQaGate,
  parseQuestions,
  parseVerdicts,
} from "../../src/agent/wiki-verification.ts";

const QUESTIONS = `[Q-01]: How does ingestion validate a payload?
Acceptance criteria:
- names the validator

[Q-02]: How are runs persisted?
Acceptance criteria:
- names the store`;

function results(entries: [string, string, string][]) {
  return `<results>${entries
    .map(
      ([id, status, missing]) =>
        `<result id="${id}" status="${status}"><missing>${missing}</missing></result>`,
    )
    .join("")}</results>`;
}

/** Wires the middleware to a scripted subagent, the way the agent supplies it. */
function verifyWith(
  respond: (type: string, description: string) => Promise<string>,
) {
  const gate = createQaGate("full");
  const middleware = createOpenWikiVerificationMiddleware(gate);
  const calls: string[] = [];
  const task = {
    name: "task",
    invoke: (input: unknown) => {
      const { subagent_type, description } = input as {
        subagent_type: string;
        description: string;
      };
      calls.push(subagent_type);
      return respond(subagent_type, description);
    },
  };
  const tools = (
    middleware as { tools: { invoke: (i: unknown) => Promise<unknown> }[] }
  ).tools;
  (
    middleware as {
      wrapModelCall: (r: unknown, h: (r: unknown) => unknown) => unknown;
    }
  ).wrapModelCall({ tools: [task] }, (r) => r);
  return {
    gate,
    calls,
    run: async () =>
      JSON.parse(String(await tools[0].invoke({}))) as Record<string, unknown>,
  };
}

describe("verify_wiki", () => {
  test("parses questions and verdicts out of their documented text blocks", () => {
    expect(parseQuestions(QUESTIONS).map((q) => q.id)).toEqual([
      "Q-01",
      "Q-02",
    ]);
    expect(parseQuestions("no questions here")).toEqual([]);
    expect(
      parseVerdicts(
        results([["Q-01", "PARTIAL", "missing /openwiki/a.md bit"]]),
      ),
    ).toEqual([
      { id: "Q-01", status: "PARTIAL", missing: "missing /openwiki/a.md bit" },
    ]);
  });

  test("passes when every question resolves", async () => {
    const h = verifyWith((type) =>
      Promise.resolve(
        type === "wiki-question-finder"
          ? QUESTIONS
          : results([
              ["Q-01", "PASS", "None"],
              ["Q-02", "PASS", "None"],
            ]),
      ),
    );
    const out = await h.run();
    expect(out.status).toBe("passed");
    expect(h.gate.status).toBe("passed");
  });

  test("groups defects by page and keeps unattributable ones", async () => {
    const h = verifyWith((type) =>
      Promise.resolve(
        type === "wiki-question-finder"
          ? QUESTIONS
          : results([
              ["Q-01", "FAIL", "not covered in /openwiki/ingest.md"],
              ["Q-02", "PARTIAL", "no page named here"],
            ]),
      ),
    );
    const out = await h.run();
    expect(out.status).toBe("failed");
    const defects = out.defectsByPage as Record<string, string[]>;
    expect(defects["/openwiki/ingest.md"]).toHaveLength(1);
    // Dropping a defect that names no page is how a wave reports false success.
    expect(defects.unattributed).toHaveLength(1);
  });

  test("reuses the question set and re-verifies only what stayed unresolved", async () => {
    let wave = 0;
    const h = verifyWith((type) => {
      if (type === "wiki-question-finder") return Promise.resolve(QUESTIONS);
      wave += 1;
      return Promise.resolve(
        wave === 1
          ? results([
              ["Q-01", "PASS", "None"],
              ["Q-02", "FAIL", "missing"],
            ])
          : results([["Q-02", "PASS", "None"]]),
      );
    });
    expect((await h.run()).unresolved).toEqual(["Q-02"]);
    const second = await h.run();
    expect(second.status).toBe("passed");
    expect(second.verified).toBe(1);
    // Generated once: regenerating would change the test between waves.
    expect(h.calls.filter((c) => c === "wiki-question-finder")).toHaveLength(1);
  });

  test("spends a budget of two waves and then refuses", async () => {
    const h = verifyWith((type) =>
      Promise.resolve(
        type === "wiki-question-finder"
          ? QUESTIONS
          : results([
              ["Q-01", "FAIL", "x"],
              ["Q-02", "FAIL", "y"],
            ]),
      ),
    );
    await h.run();
    await h.run();
    const third = await h.run();
    expect(String(third.note)).toContain("Both are spent");
    expect(h.gate.wavesRun).toBe(2);
  });

  test("records unparseable questions as infrastructure, not a defect", async () => {
    const h = verifyWith(() =>
      Promise.resolve("I could not generate questions."),
    );
    const out = await h.run();
    expect(out.status).toBe("infrastructure_error");
    expect(h.gate.status).toBe("infrastructure_error");
  });

  test("a question-finder that throws is recorded, not fatal", async () => {
    // A provider rejecting the finder's prompt once ended a run that had already
    // authored its wiki. QA failing is QA's outcome, never the run's.
    const h = verifyWith(() =>
      Promise.reject(new Error("400 Invalid prompt: policy violation")),
    );
    const out = await h.run();
    expect(out.status).toBe("infrastructure_error");
    expect(String(out.problem)).toContain("policy violation");
    expect(h.gate.status).toBe("infrastructure_error");
  });

  test("fails loudly when the verifier answers about questions it was not sent", async () => {
    const h = verifyWith((type) =>
      Promise.resolve(
        type === "wiki-question-finder"
          ? QUESTIONS
          : results([["Q-99", "PASS", "None"]]),
      ),
    );
    const out = await h.run();
    expect(out.status).toBe("infrastructure_error");
    expect(String(out.problem)).toContain("Q-99");
  });

  test("off mode never triggers and never blocks", async () => {
    const gate = createQaGate("off");
    const middleware = createOpenWikiVerificationMiddleware(gate);
    const tools = (
      middleware as { tools: { invoke: (i: unknown) => Promise<unknown> }[] }
    ).tools;
    const out = JSON.parse(String(await tools[0].invoke({}))) as {
      status: string;
    };
    expect(out.status).toBe("not_triggered");
    expect(gate.status).toBe("not_triggered");
  });
});
