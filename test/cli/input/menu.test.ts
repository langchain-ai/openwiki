import type { Key } from "ink";
import { describe, expect, test } from "vitest";
import {
  clampMenuIndex,
  getCommandOptionIndex,
  getCurrentModelOptionIndex,
  getCurrentReasoningEffortOptionIndex,
  getCurrentProviderOptionIndex,
  getModelMenuOptions,
  getReasoningEffortMenuOptions,
  isMenuDownInput,
  isMenuUpInput,
  moveMenuSelection,
  parseSlashInput,
  slashCommandOptions,
  syncMenuStateForInput,
  wrapMenuIndex,
} from "../../../src/cli/input/menu.ts";
import { SELECTABLE_OPENWIKI_PROVIDERS } from "../../../src/config/constants.ts";

const ESC = String.fromCharCode(0x1b);
const PROVIDER = "anthropic" as const;
const MODEL = "claude-opus-4-8";

/**
 * Builds a fully-populated ink Key with every flag false except the overrides.
 */
function makeKey(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...overrides,
  };
}

describe("syncMenuStateForInput", () => {
  test("opens the provider menu for /provider", () => {
    const state = syncMenuStateForInput(
      "/provider",
      { kind: "none" },
      MODEL,
      PROVIDER,
    );
    expect(state.kind).toBe("provider");
  });

  test("opens the model menu for /model", () => {
    const state = syncMenuStateForInput(
      "/model",
      { kind: "none" },
      MODEL,
      PROVIDER,
    );
    expect(state.kind).toBe("model");
  });

  test("opens the capability-gated effort menu for /effort", () => {
    const state = syncMenuStateForInput(
      "/effort",
      { kind: "none" },
      "gpt-5.6-terra",
      "openai",
      "medium",
    );
    expect(state).toEqual({ kind: "effort", selectedIndex: 3 });
  });

  test("opens the command menu for any other slash input", () => {
    const state = syncMenuStateForInput(
      "/cl",
      { kind: "none" },
      MODEL,
      PROVIDER,
    );
    expect(state).toEqual({
      kind: "commands",
      selectedIndex: getCommandOptionIndex("/cl"),
    });
  });

  test("shows no menu for non-slash input", () => {
    expect(
      syncMenuStateForInput("hello", { kind: "none" }, MODEL, PROVIDER),
    ).toEqual({ kind: "none" });
  });

  test("preserves the highlighted index when the same menu stays open", () => {
    const state = syncMenuStateForInput(
      "/provider",
      { kind: "provider", selectedIndex: 3 },
      MODEL,
      PROVIDER,
    );
    expect(state).toEqual({ kind: "provider", selectedIndex: 3 });
  });
});

describe("moveMenuSelection", () => {
  test("returns the state unchanged when no menu is open", () => {
    const none = { kind: "none" } as const;
    expect(moveMenuSelection(none, 1, MODEL, PROVIDER)).toBe(none);
  });

  test("wraps around the ends of the command menu", () => {
    const last = slashCommandOptions.length - 1;
    const wrapped = moveMenuSelection(
      { kind: "commands", selectedIndex: last },
      1,
      MODEL,
      PROVIDER,
    );
    expect(wrapped).toEqual({ kind: "commands", selectedIndex: 0 });

    const wrappedBack = moveMenuSelection(
      { kind: "commands", selectedIndex: 0 },
      -1,
      MODEL,
      PROVIDER,
    );
    expect(wrappedBack).toEqual({ kind: "commands", selectedIndex: last });
  });
});

describe("getCommandOptionIndex", () => {
  test("matches the first command the input is a prefix of", () => {
    const modelIndex = slashCommandOptions.findIndex(
      (option) => option.label === "/model",
    );
    expect(getCommandOptionIndex("/mo")).toBe(modelIndex);
  });

  test("falls back to the first command when nothing matches", () => {
    expect(getCommandOptionIndex("/zzz")).toBe(0);
  });
});

describe("getCurrentProviderOptionIndex", () => {
  test("returns the index of the current provider", () => {
    expect(getCurrentProviderOptionIndex(PROVIDER)).toBe(
      SELECTABLE_OPENWIKI_PROVIDERS.indexOf(PROVIDER),
    );
  });
});

describe("getModelMenuOptions", () => {
  test("lists the current model first and ends with a custom row", () => {
    const options = getModelMenuOptions(MODEL, PROVIDER);

    expect(options[0]).toMatchObject({ kind: "model", modelId: MODEL });
    expect(options.at(-1)).toEqual({
      kind: "custom",
      label: "Custom model ID",
    });
  });

  test("does not duplicate a preset model that is also current", () => {
    const options = getModelMenuOptions(MODEL, PROVIDER);
    const rows = options.filter(
      (option) => option.kind === "model" && option.modelId === MODEL,
    );
    expect(rows).toHaveLength(1);
  });
});

describe("getCurrentModelOptionIndex", () => {
  test("finds the row for the current model", () => {
    const index = getCurrentModelOptionIndex(MODEL, PROVIDER);
    const options = getModelMenuOptions(MODEL, PROVIDER);
    expect(options[index]).toMatchObject({ kind: "model", modelId: MODEL });
  });
});

describe("getReasoningEffortMenuOptions", () => {
  test("lists provider default plus only supported effort values", () => {
    expect(
      getReasoningEffortMenuOptions(
        "nvidia",
        "nvidia/nemotron-3-super-120b-a12b",
      ),
    ).toEqual([
      { kind: "default", label: "Provider default" },
      { effort: "none", kind: "effort", label: "none" },
      { effort: "low", kind: "effort", label: "low" },
      { effort: "high", kind: "effort", label: "high" },
    ]);
    expect(getReasoningEffortMenuOptions("openai", "gpt-5.5")).toEqual([]);
  });

  test("finds the existing effort or falls back to provider default", () => {
    expect(
      getCurrentReasoningEffortOptionIndex("openai", "gpt-5.6-terra", "xhigh"),
    ).toBe(5);
    expect(
      getCurrentReasoningEffortOptionIndex("openai", "gpt-5.5", "high"),
    ).toBe(0);
  });
});

describe("parseSlashInput", () => {
  test("returns the matched command and its trailing arguments", () => {
    const parsed = parseSlashInput("/model gpt-4 extra");
    expect(parsed?.option.id).toBe("model");
    expect(parsed?.args).toBe("gpt-4 extra");
  });

  test("returns null for input whose first token is not a command", () => {
    expect(parseSlashInput("hello there")).toBeNull();
  });
});

describe("isMenuUpInput / isMenuDownInput", () => {
  test("recognize the parsed arrow flags", () => {
    expect(isMenuUpInput("", makeKey({ upArrow: true }))).toBe(true);
    expect(isMenuDownInput("", makeKey({ downArrow: true }))).toBe(true);
  });

  test("recognize the raw ANSI arrow sequences", () => {
    expect(isMenuUpInput(`${ESC}[A`, makeKey())).toBe(true);
    expect(isMenuDownInput(`${ESC}[B`, makeKey())).toBe(true);
  });

  test("are false for unrelated input", () => {
    expect(isMenuUpInput("a", makeKey())).toBe(false);
    expect(isMenuDownInput("a", makeKey())).toBe(false);
  });
});

describe("clampMenuIndex", () => {
  test("clamps into [0, itemCount - 1] and handles an empty menu", () => {
    expect(clampMenuIndex(-3, 5)).toBe(0);
    expect(clampMenuIndex(9, 5)).toBe(4);
    expect(clampMenuIndex(2, 0)).toBe(0);
  });
});

describe("wrapMenuIndex", () => {
  test("cycles past either end and returns 0 for an empty menu", () => {
    expect(wrapMenuIndex(5, 5)).toBe(0);
    expect(wrapMenuIndex(-1, 5)).toBe(4);
    expect(wrapMenuIndex(3, 0)).toBe(0);
  });
});
