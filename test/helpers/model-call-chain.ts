export type ChainRequest = {
  model: unknown;
  modelSettings?: Record<string, unknown>;
  tools?: Array<{ name: string }>;
};

export type ChainMiddleware = {
  name?: string;
  wrapModelCall?: (
    request: ChainRequest,
    handler: (next: ChainRequest) => Promise<ChainRequest>,
  ) => Promise<ChainRequest>;
};

/**
 * Runs a `createDeepAgent` middleware array the way LangChain's AgentNode does:
 * composed last to first, so the first entry is the outermost wrapper, ending
 * at a handler that returns whatever request finally reached the model.
 *
 * Lets a test assert on what a middleware array as a whole sends, rather than
 * on what one middleware in it contributes — so a later middleware that drops
 * an earlier one's contribution is caught.
 *
 * @param middleware - The agent's middleware array, in declaration order.
 * @param request - Model request entering the outermost wrapper.
 * @returns The request as the model would have received it.
 */
export async function runModelCallChain(
  middleware: ChainMiddleware[],
  request: ChainRequest,
): Promise<ChainRequest> {
  let handler = (next: ChainRequest) => Promise.resolve(next);

  for (let index = middleware.length - 1; index >= 0; index -= 1) {
    const wrapModelCall = middleware[index]?.wrapModelCall;

    if (!wrapModelCall) {
      continue;
    }

    const innerHandler = handler;
    handler = (next) => wrapModelCall(next, innerHandler);
  }

  return handler(request);
}
