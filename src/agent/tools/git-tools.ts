import {
  DynamicStructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";
import { runGitCommand, type GitCommandResult } from "./shared/git-exec.js";
import {
  isSafeGitRef,
  resolveRealPathWithinRoot,
  validateVirtualPath,
} from "./shared/path-validation.js";

export type GitReadOnlyToolContext = {
  cwd: string;
};

const DEFAULT_LOG_MAX_COUNT = 20;
const MAX_LOG_MAX_COUNT = 100;

/**
 * Builds the read-only structured git tools exposed to repository init/update
 * runs. Every tool maps to a fixed git subcommand with validated inputs; none
 * accept a free-form command string and none run mutating subcommands.
 */
export function createGitReadOnlyTools(
  context: GitReadOnlyToolContext,
): StructuredToolInterface[] {
  const { cwd } = context;

  return [
    new DynamicStructuredTool({
      name: "openwiki_git_log",
      description:
        'Show recent commit history as a one-line log. Optional {"maxCount":20,"filePath":"src/index.ts"}. filePath is repository-relative.',
      schema: {
        type: "object",
        properties: {
          maxCount: { type: "number" },
          filePath: { type: "string" },
        },
        additionalProperties: false,
      } as const,
      func: async (input) => {
        const maxCount = clampMaxCount(getNumberInput(input, "maxCount"));
        const args = ["log", "--max-count", String(maxCount), "--oneline"];

        const pathspec = await appendFilePathspec(args, input, cwd);
        if (pathspec.error) {
          return pathspec.error;
        }

        return formatGitResult(await runGitCommand(cwd, args));
      },
    }),
    new DynamicStructuredTool({
      name: "openwiki_git_show",
      description:
        'Show a commit or a file at a commit. Input {"ref":"HEAD","filePath":"src/index.ts"}. ref must be a hex object name or a HEAD-relative form such as HEAD~2.',
      schema: {
        type: "object",
        properties: {
          ref: { type: "string" },
          filePath: { type: "string" },
        },
        required: ["ref"],
        additionalProperties: false,
      } as const,
      func: async (input) => {
        const ref = getStringInput(input, "ref");
        if (!isSafeGitRef(ref)) {
          return unsafeRefError(ref);
        }

        const args = ["show", ref];

        const pathspec = await appendFilePathspec(args, input, cwd);
        if (pathspec.error) {
          return pathspec.error;
        }

        return formatGitResult(await runGitCommand(cwd, args));
      },
    }),
    new DynamicStructuredTool({
      name: "openwiki_git_blame",
      description:
        'Show line-by-line authorship for a file. Input {"filePath":"src/index.ts","startLine":1,"endLine":40}. Line range is optional.',
      schema: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          startLine: { type: "number" },
          endLine: { type: "number" },
        },
        required: ["filePath"],
        additionalProperties: false,
      } as const,
      func: async (input) => {
        const args = ["blame"];

        const startLine = getNumberInput(input, "startLine");
        const endLine = getNumberInput(input, "endLine");
        const range = formatLineRange(startLine, endLine);
        if (range.error) {
          return range.error;
        }
        if (range.value) {
          args.push("-L", range.value);
        }

        const pathspec = await appendFilePathspec(args, input, cwd, {
          required: true,
        });
        if (pathspec.error) {
          return pathspec.error;
        }

        return formatGitResult(await runGitCommand(cwd, args));
      },
    }),
    new DynamicStructuredTool({
      name: "openwiki_git_status",
      description:
        "Show the short working-tree status, including untracked files. Takes no input.",
      schema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      } as const,
      func: async () =>
        formatGitResult(
          await runGitCommand(cwd, [
            "status",
            "--short",
            "--untracked-files=all",
          ]),
        ),
    }),
    new DynamicStructuredTool({
      name: "openwiki_git_diff",
      description:
        'Show a diff against a ref (default HEAD). Input {"ref":"HEAD","filePath":"src/index.ts"}. ref must be a hex object name or a HEAD-relative form.',
      schema: {
        type: "object",
        properties: {
          ref: { type: "string" },
          filePath: { type: "string" },
        },
        additionalProperties: false,
      } as const,
      func: async (input) => {
        const ref = getOptionalStringInput(input, "ref") ?? "HEAD";
        if (!isSafeGitRef(ref)) {
          return unsafeRefError(ref);
        }

        const args = ["diff", ref];

        const pathspec = await appendFilePathspec(args, input, cwd);
        if (pathspec.error) {
          return pathspec.error;
        }

        return formatGitResult(await runGitCommand(cwd, args));
      },
    }),
  ];
}

async function appendFilePathspec(
  args: string[],
  input: unknown,
  cwd: string,
  options: { required?: boolean } = {},
): Promise<{ error?: string }> {
  const filePath = getOptionalStringInput(input, "filePath");

  if (filePath === null || filePath.length === 0) {
    if (options.required === true) {
      return { error: "filePath is required." };
    }

    return {};
  }

  try {
    await resolveRealPathWithinRoot(filePath, cwd);
    args.push("--", validateVirtualPath(filePath, cwd));

    return {};
  } catch (error) {
    return { error: describeValidationError(error) };
  }
}

function clampMaxCount(value: number | null): number {
  if (value === null || !Number.isFinite(value)) {
    return DEFAULT_LOG_MAX_COUNT;
  }

  const rounded = Math.floor(value);

  if (rounded < 1) {
    return 1;
  }

  return Math.min(rounded, MAX_LOG_MAX_COUNT);
}

function formatLineRange(
  startLine: number | null,
  endLine: number | null,
): { value?: string; error?: string } {
  if (startLine === null && endLine === null) {
    return {};
  }

  if (startLine === null || endLine === null) {
    return { error: "Provide both startLine and endLine, or neither." };
  }

  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    return {
      error:
        "startLine and endLine must be positive integers with endLine >= startLine.",
    };
  }

  return { value: `${startLine},${endLine}` };
}

function formatGitResult(result: GitCommandResult): string {
  if (result.error) {
    return [`git error: ${result.error}`, result.output]
      .filter(Boolean)
      .join("\n");
  }

  return result.output.length > 0 ? result.output : "(no output)";
}

function unsafeRefError(ref: string): string {
  return `Refused unsafe git ref: ${ref}. Use a hex object name or a HEAD-relative form such as HEAD, HEAD~2, or HEAD^1.`;
}

function describeValidationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getStringInput(input: unknown, key: string): string {
  const value = getOptionalStringInput(input, key);

  if (value === null) {
    throw new Error(`Missing string input: ${key}`);
  }

  return value;
}

function getOptionalStringInput(input: unknown, key: string): string | null {
  if (!isRecord(input) || input[key] === undefined || input[key] === null) {
    return null;
  }

  if (typeof input[key] !== "string") {
    throw new Error(`Expected string input: ${key}`);
  }

  return input[key];
}

function getNumberInput(input: unknown, key: string): number | null {
  if (!isRecord(input) || input[key] === undefined || input[key] === null) {
    return null;
  }

  if (typeof input[key] !== "number") {
    throw new Error(`Expected number input: ${key}`);
  }

  return input[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
