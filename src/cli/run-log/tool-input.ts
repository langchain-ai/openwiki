import { isRecord } from "../guards.js";

/**
 * Parses a tool input that may arrive as stringified JSON.
 */
export function parseToolInput(input: unknown): unknown {
  if (typeof input !== "string") {
    return input;
  }

  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

/**
 * Counts targets stored directly or under the first matching input key.
 */
export function countToolTargets(input: unknown, keys: string[]): number {
  const parsedInput = parseToolInput(input);

  if (Array.isArray(parsedInput)) {
    return Math.max(parsedInput.length, 1);
  }

  if (!isRecord(parsedInput)) {
    return 1;
  }

  for (const key of keys) {
    const value = parsedInput[key];

    if (Array.isArray(value)) {
      return Math.max(value.length, 1);
    }

    if (typeof value === "string" && value.trim().length > 0) {
      return 1;
    }
  }

  return 1;
}
