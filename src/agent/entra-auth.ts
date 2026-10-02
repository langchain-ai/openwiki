/**
 * Build an OpenAI SDK credential callback backed by Microsoft Entra ID.
 *
 * Azure Identity caches tokens and refreshes them before expiry. The OpenAI
 * SDK calls the returned function for each request, allowing a long-running
 * OpenWiki model to use refreshed credentials without reconstruction.
 * Identity is loaded only when the callback is first invoked.
 *
 * @param baseURL - OpenAI-compatible endpoint that will receive the token.
 * @param scope - Entra OAuth scope accepted by the target gateway.
 * @returns An asynchronous API-key callback for the OpenAI SDK.
 * @throws When the endpoint is unsafe or token acquisition fails.
 */
export function createEntraTokenProvider(
  baseURL: string | undefined,
  scope: string,
): () => Promise<string> {
  let endpoint: URL;

  try {
    endpoint = new URL(baseURL ?? "");
  } catch {
    throw new Error(
      "Entra ID authentication requires an HTTPS OPENAI_COMPATIBLE_BASE_URL.",
    );
  }

  const hostname = endpoint.hostname.toLowerCase().replace(/\.$/u, "");

  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    hostname === "169.254.169.254" ||
    hostname === "metadata.google.internal"
  ) {
    throw new Error(
      "Entra ID authentication requires an HTTPS OPENAI_COMPATIBLE_BASE_URL without embedded credentials or a metadata host.",
    );
  }

  let tokenProvider: Promise<() => Promise<string>> | undefined;

  return async () => {
    try {
      tokenProvider ??= import("@azure/identity")
        .then(({ DefaultAzureCredential, getBearerTokenProvider }) =>
          getBearerTokenProvider(new DefaultAzureCredential(), scope),
        )
        .catch((error: unknown) => {
          // An import or constructor failure must not poison future attempts.
          tokenProvider = undefined;
          throw error;
        });

      return await (
        await tokenProvider
      )();
    } catch {
      // Identity errors can contain response details and credential material.
      // Never attach or log the original error in model diagnostics.
      throw new Error(
        "Unable to obtain a Microsoft Entra ID access token. Configure Azure Identity (az login, managed/workload identity, or environment credentials) and check OPENAI_COMPATIBLE_ENTRA_SCOPE and gateway access permissions.",
      );
    }
  };
}
