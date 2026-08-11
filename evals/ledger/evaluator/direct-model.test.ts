import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z, type ZodType } from "zod";

import { EvaluationError } from "../core/errors.js";
import { invokeStructuredModel } from "./direct-model.js";

const outputSchema = z.object({
  verdict: z.enum(["yes", "no"]),
  evidence: z.array(z.string()).default([]),
});

type Output = z.infer<typeof outputSchema>;

/**
 * Captured state and queued behavior for a direct-model test double.
 */
interface FakeModelController {
  /**
   * Responses or failures consumed by successive invocations.
   */
  responses: Array<unknown | Error>;

  /**
   * Message arrays received by successive invocations.
   */
  messages: unknown[];

  /**
   * Abort signals received by successive invocations.
   */
  signals: AbortSignal[];

  /**
   * Schemas supplied to successive structured-output wrappers.
   */
  schemas: unknown[];

  /**
   * When true, every invocation remains pending until the caller times out.
   */
  hangs: boolean;
}

/**
 * Build a minimal BaseChatModel test double exposing structured-output calls.
 *
 * @param controller - Mutable behavior and capture state.
 *
 * @returns A model implementing the method used by the direct-call helper.
 */
function fakeModel(controller: FakeModelController): BaseChatModel {
  return {
    withStructuredOutput: (schema: ZodType<Output>) => {
      controller.schemas.push(schema);

      return {
        invoke: async (
          messages: unknown,
          options?: { signal?: AbortSignal },
        ) => {
          controller.messages.push(messages);

          if (options?.signal !== undefined) {
            controller.signals.push(options.signal);
          }

          if (controller.hangs) {
            return new Promise<never>(() => undefined);
          }

          const response = controller.responses.shift();

          if (response instanceof Error) {
            throw response;
          }

          return response;
        },
      };
    },
  } as unknown as BaseChatModel;
}

/**
 * Create fresh model-control state for one test.
 *
 * @param responses - Optional queued invocation results.
 *
 * @returns Empty capture state with the supplied response queue.
 */
function controller(
  responses: Array<unknown | Error> = [],
): FakeModelController {
  return { responses, messages: [], signals: [], schemas: [], hangs: false };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("invokeStructuredModel", () => {
  test("sends one system and user message and reapplies schema defaults", async () => {
    const control = controller([{ verdict: "yes" }]);

    const result = await invokeStructuredModel({
      model: fakeModel(control),
      pass: "forgetting",
      checkpointId: "T0",
      systemPrompt: "system instructions",
      taskPrompt: "bounded task",
      schema: outputSchema,
      timeoutMs: 1_000,
    });

    expect(result).toEqual({ verdict: "yes", evidence: [] });
    expect(control.schemas).toEqual([outputSchema]);
    expect(control.messages).toEqual([
      [
        { role: "system", content: "system instructions" },
        { role: "user", content: "bounded task" },
      ],
    ]);
    expect(control.signals).toHaveLength(1);
    expect(control.signals[0].aborted).toBe(false);
  });

  test("retries once after schema failure and then succeeds", async () => {
    const control = controller([
      { verdict: "invalid" },
      { verdict: "no", evidence: ["section-1"] },
    ]);

    const result = await invokeStructuredModel({
      model: fakeModel(control),
      pass: "forgetting",
      checkpointId: "T2",
      systemPrompt: "system",
      taskPrompt: "task",
      schema: outputSchema,
      timeoutMs: 1_000,
    });

    expect(result.verdict).toBe("no");
    expect(control.messages).toHaveLength(2);
    expect(control.signals).toHaveLength(2);
    expect(control.signals[0]).not.toBe(control.signals[1]);
  });

  test("retries once after completeness validation fails", async () => {
    const control = controller([
      { verdict: "no" },
      { verdict: "yes", evidence: ["section-1"] },
    ]);

    const result = await invokeStructuredModel({
      model: fakeModel(control),
      pass: "forgetting",
      checkpointId: "T1",
      systemPrompt: "system",
      taskPrompt: "task",
      schema: outputSchema,
      timeoutMs: 1_000,
      validate: (parsed) => {
        if (parsed.evidence.length === 0) {
          throw new Error("Evidence is required.");
        }
      },
    });

    expect(result.evidence).toEqual(["section-1"]);
    expect(control.messages).toHaveLength(2);
  });

  test("aborts timed-out attempts and rejects after the second deadline", async () => {
    vi.useFakeTimers();
    const control = controller();
    control.hangs = true;

    const result = invokeStructuredModel({
      model: fakeModel(control),
      pass: "precision-extraction",
      checkpointId: "T4",
      systemPrompt: "system",
      taskPrompt: "task",
      schema: outputSchema,
      timeoutMs: 25,
    });
    const rejection = expect(result).rejects.toThrow(
      /checkpoint "T4" pass "precision-extraction" failed after 2 attempts.*Timed out after 25ms/u,
    );

    await vi.runAllTimersAsync();
    await rejection;

    expect(control.messages).toHaveLength(2);
    expect(control.signals).toHaveLength(2);
    expect(control.signals.every((signal) => signal.aborted)).toBe(true);
  });

  test("stops after two invocation failures and includes bounded context", async () => {
    const control = controller([
      new Error("temporary provider failure"),
      new Error(
        "final provider failure while handling SECRET ARTIFACT CONTENT",
      ),
      { verdict: "yes" },
    ]);

    await expect(
      invokeStructuredModel({
        model: fakeModel(control),
        pass: "precision-judgment",
        checkpointId: "T8",
        systemPrompt: "system",
        taskPrompt: "SECRET ARTIFACT CONTENT",
        schema: outputSchema,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(
      /checkpoint "T8" pass "precision-judgment" failed after 2 attempts: Error: final provider failure while handling \[prompt omitted\]/u,
    );

    expect(control.messages).toHaveLength(2);

    try {
      await invokeStructuredModel({
        model: fakeModel(controller([new Error("x"), new Error("y")])),
        pass: "forgetting",
        checkpointId: "T0",
        systemPrompt: "system",
        taskPrompt: "SECRET ARTIFACT CONTENT",
        schema: outputSchema,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(EvaluationError);
      expect((error as Error).message).not.toContain("SECRET ARTIFACT CONTENT");
    }
  });

  test.each([0, -1, 1.5, Number.NaN])(
    "rejects invalid timeout %s without invoking the model",
    async (timeoutMs) => {
      const control = controller([{ verdict: "yes" }]);

      await expect(
        invokeStructuredModel({
          model: fakeModel(control),
          pass: "forgetting",
          checkpointId: "T0",
          systemPrompt: "system",
          taskPrompt: "task",
          schema: outputSchema,
          timeoutMs,
        }),
      ).rejects.toThrow(/positive integer timeoutMs/u);
      expect(control.messages).toHaveLength(0);
    },
  );
});
