import { describe, expect, test } from "vitest";

import { ingestAllConnectors } from "../src/connectors/tools.ts";
import type {
  ConnectorIngestResult,
  ConnectorRuntime,
} from "../src/connectors/types.ts";

// ingestAllConnectors ran connectors in a bare sequential loop with no error
// handling, so the first throw — an un-refreshable token, a 429 — propagated out
// and `results` was never returned, discarding every connector that had already
// succeeded (issue #412). The result type already models failure via
// status:"error", so a failed connector should report itself instead.

function ok(id: string): ConnectorIngestResult {
  return {
    connectorId: id as ConnectorIngestResult["connectorId"],
    message: `${id} ok`,
    rawFiles: [`${id}/raw.json`],
    runId: "run-1",
    statePath: `~/.openwiki/connectors/${id}/state.json`,
    status: "success",
    warnings: [],
  };
}

function stub(id: string, behaviour: "ok" | "throw"): ConnectorRuntime {
  return {
    id,
    ingest: () =>
      behaviour === "throw"
        ? Promise.reject(new Error(`${id} token could not be refreshed`))
        : Promise.resolve(ok(id)),
  } as unknown as ConnectorRuntime;
}

describe("ingestAllConnectors", () => {
  test("a failure in the middle does not discard the connectors that succeeded", async () => {
    const { results } = await ingestAllConnectors({
      alpha: stub("alpha", "ok"),
      beta: stub("beta", "throw"),
      gamma: stub("gamma", "ok"),
    });

    expect(results).toHaveLength(3);
    expect(results.map((result) => result.status)).toEqual([
      "success",
      "error",
      "success",
    ]);
    // The successful connectors keep their raw files. Previously this whole
    // array was lost to the throw.
    expect(results[0].rawFiles).toEqual(["alpha/raw.json"]);
    expect(results[2].rawFiles).toEqual(["gamma/raw.json"]);
  });

  test("a failure the FIRST connector hits still runs the rest", async () => {
    const { results } = await ingestAllConnectors({
      alpha: stub("alpha", "throw"),
      beta: stub("beta", "ok"),
    });

    expect(results.map((result) => result.connectorId)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(results[1].status).toBe("success");
  });

  test("the failure carries the cause, not just a status", async () => {
    const { results } = await ingestAllConnectors({
      alpha: stub("alpha", "throw"),
    });

    expect(results[0].status).toBe("error");
    expect(results[0].message).toContain("Ingestion failed");
    expect(results[0].message).toContain("token could not be refreshed");
    expect(results[0].warnings[0]).toContain("token could not be refreshed");
  });

  test("every connector failing yields one error result each, not a throw", async () => {
    const { results } = await ingestAllConnectors({
      alpha: stub("alpha", "throw"),
      beta: stub("beta", "throw"),
    });

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.status === "error")).toBe(true);
  });

  test("a non-Error rejection is still reported", async () => {
    const results = (
      await ingestAllConnectors({
        alpha: {
          id: "alpha",
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          ingest: () => Promise.reject("rate limited"),
        } as unknown as ConnectorRuntime,
      })
    ).results;

    expect(results[0].status).toBe("error");
    expect(results[0].message).toContain("rate limited");
  });
});
