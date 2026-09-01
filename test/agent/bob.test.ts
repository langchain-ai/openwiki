import { describe, it, expect, vi, afterEach } from "vitest";
import { createBobFetch, BOB_USER_AGENT } from "../../src/agent/bob.js";
import {
  providerHasFixedModel,
  getProviderFixedModel,
} from "../../src/config/constants.js";

describe("createBobFetch", () => {
  afterEach(() => {
    delete process.env["BOB_API_KEY"];
  });

  it("rewrites Authorization header to Apikey scheme", async () => {
    process.env["BOB_API_KEY"] = "bob_prod_bob-apikey_test123";

    const mockFetch = vi.fn().mockResolvedValue(new Response());
    const bobFetch = createBobFetch(mockFetch);

    await bobFetch(
      "https://api.us-east.bob.ibm.com/inference/v1/chat/completions",
      {
        method: "POST",
        headers: { Authorization: "Bearer bob-placeholder" },
        body: "{}",
      },
    );

    const [, init] = mockFetch.mock.calls[0] as [unknown, RequestInit];
    const headers = new Headers(init.headers);

    expect(headers.get("Authorization")).toBe(
      "Apikey bob_prod_bob-apikey_test123",
    );
  });

  it("sets the required User-Agent header", async () => {
    process.env["BOB_API_KEY"] = "bob_prod_bob-apikey_test123";

    const mockFetch = vi.fn().mockResolvedValue(new Response());
    const bobFetch = createBobFetch(mockFetch);

    await bobFetch(
      "https://api.us-east.bob.ibm.com/inference/v1/chat/completions",
      {},
    );

    const [, init] = mockFetch.mock.calls[0] as [unknown, RequestInit];
    const headers = new Headers(init.headers);

    expect(headers.get("User-Agent")).toBe(BOB_USER_AGENT);
  });

  it("uses an empty string when BOB_API_KEY is not set", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response());
    const bobFetch = createBobFetch(mockFetch);

    await bobFetch(
      "https://api.us-east.bob.ibm.com/inference/v1/chat/completions",
      {},
    );

    const [, init] = mockFetch.mock.calls[0] as [unknown, RequestInit];
    const headers = new Headers(init.headers);

    // Headers may trim trailing whitespace; match on the prefix
    expect(headers.get("Authorization")).toMatch(/^Apikey/);
  });

  it("delegates to the underlying fetch implementation", async () => {
    process.env["BOB_API_KEY"] = "key";
    const expectedResponse = new Response('{"ok":true}', { status: 200 });
    const mockFetch = vi.fn().mockResolvedValue(expectedResponse);
    const bobFetch = createBobFetch(mockFetch);

    const result = await bobFetch("https://example.com", {});

    expect(result).toBe(expectedResponse);
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});

describe("bob provider — fixed model", () => {
  it("reports that bob has a fixed model", () => {
    expect(providerHasFixedModel("bob")).toBe(true);
  });

  it("returns 'premium' as the fixed model", () => {
    expect(getProviderFixedModel("bob")).toBe("premium");
  });

  it("other providers do not have a fixed model", () => {
    expect(providerHasFixedModel("openai")).toBe(false);
    expect(providerHasFixedModel("anthropic")).toBe(false);
  });
});
