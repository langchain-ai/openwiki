import { describe, expect, test } from "vitest";
import {
  getAuthFix,
  getAuthFixSteps,
  type AuthFix,
} from "../../../src/cli/diagnostics/auth-fix.ts";
import { getProviderApiKeyEnvKey } from "../../../src/config/constants.ts";

describe("getAuthFixSteps", () => {
  test("returns AWS credential-chain guidance for aws-sdk providers", () => {
    const steps = getAuthFixSteps({
      apiKeyEnvKey: undefined,
      keyFromShell: false,
      provider: "bedrock",
    });

    expect(steps).toHaveLength(4);
    expect(steps[0]).toContain("aws sts get-caller-identity");
    // The AWS branch returns early, so the generic re-enter step is absent.
    expect(steps.some((step) => step.includes("--init"))).toBe(false);
  });

  test("leads with the unset-shell step when the key came from the shell", () => {
    const steps = getAuthFixSteps({
      apiKeyEnvKey: "ANTHROPIC_API_KEY",
      keyFromShell: true,
      provider: "anthropic",
    });

    expect(steps).toHaveLength(2);
    expect(steps[0]).toContain("came from your shell");
    expect(steps[0]).toContain("unset ANTHROPIC_API_KEY");
    expect(steps[1]).toContain("Re-enter your key");
  });

  test("returns only the re-enter step when the key did not come from the shell", () => {
    const steps = getAuthFixSteps({
      apiKeyEnvKey: "ANTHROPIC_API_KEY",
      keyFromShell: false,
      provider: "anthropic",
    });

    expect(steps).toEqual([
      "Re-enter your key: re-run openwiki --init, or edit ~/.openwiki/.env.",
    ]);
  });
});

describe("getAuthFix", () => {
  test("returns undefined for an error that is not an auth failure", () => {
    expect(getAuthFix(new Error("boom"), "boom", "anthropic")).toBeUndefined();
  });

  test("describes the failing provider's key for a 401 auth error", () => {
    const fix = getAuthFix({ statusCode: 401 }, "unauthorized", "anthropic");

    const expected: AuthFix = {
      apiKeyEnvKey: getProviderApiKeyEnvKey("anthropic"),
      keyFromShell: false,
      provider: "anthropic",
    };

    expect(fix).toEqual(expected);
  });
});
