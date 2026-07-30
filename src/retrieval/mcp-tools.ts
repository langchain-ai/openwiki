interface ToolDefinition {
  annotations: { destructiveHint: false; readOnlyHint: true };
  description: string;
  inputSchema: object;
  name: string;
}

export const SEARCH_SCOPES = ["all", "wiki", "source_code", "tests"] as const;

function integerSchema(
  minimum: number,
  maximum: number,
  defaultValue: number,
): object {
  return { default: defaultValue, maximum, minimum, type: "integer" };
}

function querySchema(properties: Record<string, object>): object {
  return {
    additionalProperties: false,
    properties: {
      query: { maxLength: 500, minLength: 1, type: "string" },
      ...properties,
    },
    required: ["query"],
    type: "object",
  };
}

function tool(
  name: string,
  description: string,
  inputSchema: object,
): ToolDefinition {
  return {
    annotations: { destructiveHint: false, readOnlyHint: true },
    description,
    inputSchema,
    name,
  };
}

export const RETRIEVAL_TOOL_DEFINITIONS = [
  tool(
    "search",
    "Retrieve focused wiki guidance, implementation evidence, or analogous tests with automatic lexical, semantic, and OKF ranking. Use wiki for contracts and invariants; verify every citation in source.",
    querySchema({
      limit: integerSchema(1, 10, 5),
      scope: {
        default: "all",
        description:
          "Search all indexed content, only generated wiki pages, implementation source excluding tests, or only test/spec files.",
        enum: SEARCH_SCOPES,
        type: "string",
      },
    }),
  ),
  tool(
    "change_surface",
    "Build a compact, evidence-backed task brief before broad exploration: likely owners, invariants, analogous tests, conditional delivery surfaces, and narrow validation. Pass changed_paths later to review documented adjacent surfaces.",
    querySchema({
      changed_paths: {
        description:
          "Optional repository-relative paths already changed. When present, the response flags documented adjacent surfaces to verify; flags are evidence gaps, not automatic requirements.",
        items: { maxLength: 300, minLength: 1, type: "string" },
        maxItems: 50,
        type: "array",
      },
      limit: integerSchema(1, 8, 6),
    }),
  ),
] as const satisfies readonly ToolDefinition[];
