import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildSubagentDisabledProfile,
  createOpenWikiMiddleware,
  isSubagentDisabled,
} from "../src/agent/index.ts";

const ENV_KEY = "OPENWIKI_DISABLE_SUBAGENTS";
let previousValue: string | undefined;

beforeEach(() => {
  previousValue = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (previousValue === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = previousValue;
  }
});

// Invoke a middleware's wrapModelCall with a captured request so we can
// inspect the tool list the model would actually be handed.
type MinimalWrapModelCallMiddleware = {
  wrapModelCall: (
    request: { tools: Array<{ name: string }> },
    handler: (request: { tools: Array<{ name: string }> }) => Promise<unknown>,
  ) => Promise<unknown>;
};

async function toolsSeenByModel(
  middleware: ReturnType<typeof createOpenWikiMiddleware>,
  tools: Array<{ name: string }>,
): Promise<Array<{ name: string }>> {
  expect(middleware.length).toBe(1);
  let captured: Array<{ name: string }> = tools;
  const [wrapper] = middleware as unknown as MinimalWrapModelCallMiddleware[];
  await wrapper.wrapModelCall({ tools }, (request) => {
    captured = request.tools;
    return Promise.resolve({});
  });
  return captured;
}

describe("isSubagentDisabled", () => {
  test('only reports true for exactly "1"', () => {
    process.env[ENV_KEY] = "1";
    expect(isSubagentDisabled()).toBe(true);

    delete process.env[ENV_KEY];
    expect(isSubagentDisabled()).toBe(false);

    process.env[ENV_KEY] = "true";
    expect(isSubagentDisabled()).toBe(false);
  });
});

describe("buildSubagentDisabledProfile", () => {
  test("drops the task tool and turns off the general-purpose subagent", () => {
    const profile = buildSubagentDisabledProfile();
    expect(profile.excludedTools).toEqual(["task"]);
    expect(profile.generalPurposeSubagent.enabled).toBe(false);
  });
});

describe("createOpenWikiMiddleware", () => {
  test("default behavior is unchanged: no middleware when unset", () => {
    const middleware = createOpenWikiMiddleware();
    expect(middleware).toEqual([]);
  });

  test("when disabled, the task tool is excluded from the model call", async () => {
    process.env[ENV_KEY] = "1";
    const middleware = createOpenWikiMiddleware();
    const tools = [
      { name: "read_file" },
      { name: "task" },
      { name: "write_file" },
    ];

    const seen = await toolsSeenByModel(middleware, tools);

    expect(seen.map((tool) => tool.name)).toEqual(["read_file", "write_file"]);
  });
});
