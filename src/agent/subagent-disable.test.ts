import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildSubagentDisabledProfile,
  createOpenWikiMiddleware,
  isSubagentDisabled,
} from "./index.js";

const ENV_KEY = "OPENWIKI_DISABLE_SUBAGENTS";

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env[ENV_KEY];
  if (value === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = value;
  }
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = previous;
    }
  }
}

// Invoke a middleware's wrapModelCall with a captured request so we can inspect
// the tool list the model would actually be handed.
async function toolsSeenByModel(
  middleware: ReturnType<typeof createOpenWikiMiddleware>,
  tools: Array<{ name: string }>,
): Promise<Array<{ name: string }>> {
  assert.equal(middleware.length, 1, "expected exactly one middleware");
  let captured: Array<{ name: string }> = tools;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (middleware[0] as any).wrapModelCall(
    { tools },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (request: any) => {
      captured = request.tools;
      return {};
    },
  );
  return captured;
}

test('isSubagentDisabled only reports true for exactly "1"', () => {
  assert.equal(
    withEnv("1", isSubagentDisabled),
    true,
    "OPENWIKI_DISABLE_SUBAGENTS=1 should disable subagents",
  );
  assert.equal(
    withEnv(undefined, isSubagentDisabled),
    false,
    "unset should leave subagents enabled",
  );
  assert.equal(
    withEnv("true", isSubagentDisabled),
    false,
    'only the literal "1" opts in; other truthy strings do not',
  );
});

test("disabled profile drops the task tool and turns off the general-purpose subagent", () => {
  const profile = buildSubagentDisabledProfile();
  assert.deepEqual(profile.excludedTools, ["task"]);
  assert.equal(profile.generalPurposeSubagent.enabled, false);
});

test("default behavior is unchanged: no middleware and no tools removed when unset", async () => {
  const middleware = withEnv(undefined, createOpenWikiMiddleware);
  assert.deepEqual(middleware, [], "unset should add no middleware");
});

test("when disabled, the task tool is excluded from the model call", async () => {
  const middleware = withEnv("1", createOpenWikiMiddleware);
  const tools = [
    { name: "read_file" },
    { name: "task" },
    { name: "write_file" },
  ];
  const seen = await toolsSeenByModel(middleware, tools);
  assert.deepEqual(
    seen.map((tool) => tool.name),
    ["read_file", "write_file"],
    "task must be filtered out; all other tools pass through unchanged",
  );
});
