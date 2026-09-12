import { BOB_API_KEY_ENV_KEY } from "../config/constants.js";

/** User-Agent registered with the Bob team for OpenWiki inference requests. */
export const BOB_USER_AGENT = "ibm-bob-openwiki-provider";

/**
 * Returns a `fetch` wrapper that adapts outgoing requests for the IBM Bob
 * inference endpoint:
 *
 * - Rewrites `Authorization: Bearer <placeholder>` → `Authorization: Apikey <key>`
 * - Sets `User-Agent: ibm-bob-openwiki-provider` (required by Bob's Cloudflare WAF)
 *
 * The real API key is read from the environment at call time so that a
 * hot-reloaded `.env` value is always picked up.
 */
export function createBobFetch(
  fetchImpl: typeof fetch = globalThis.fetch,
): typeof fetch {
  return (input, init) => {
    const apiKey = process.env[BOB_API_KEY_ENV_KEY] ?? "";
    const headers = new Headers(init?.headers);

    headers.set("Authorization", `Apikey ${apiKey}`);
    headers.set("User-Agent", BOB_USER_AGENT);

    return fetchImpl(input, { ...init, headers });
  };
}
