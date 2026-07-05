import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { ChatResult } from "@langchain/core/outputs";
import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { createOpencodeClient } from "@opencode-ai/sdk";
import type { Part } from "@opencode-ai/sdk";

export class OpenCodeModel extends BaseChatModel {
  private clientPromise: ReturnType<typeof createOpencodeClient> | null = null;
  private baseUrl: string;
  private cwd: string;
  private modelId: string;

  constructor(baseUrl: string, cwd: string, modelId: string) {
    super({});
    this.baseUrl = baseUrl;
    this.cwd = cwd;
    this.modelId = modelId;
  }

  private getClient() {
    if (!this.clientPromise) {
      this.clientPromise = createOpencodeClient({
        baseUrl: this.baseUrl,
      });
    }
    return this.clientPromise;
  }

  async _generate(
    messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const client = this.getClient();

    const sessionResp = await client.session.create({
      query: { directory: this.cwd },
    });
    if (!sessionResp?.data) {
      throw new Error("Failed to create OpenCode session: no response");
    }
    const sessionId = sessionResp.data.id;

    let system = "";
    const parts: { type: "text"; text: string }[] = [];

    for (const msg of messages) {
      if (msg instanceof SystemMessage) {
        system += (system ? "\n" : "") + String(msg.content);
      } else {
        const role =
          msg instanceof HumanMessage
            ? "User"
            : msg instanceof AIMessage
              ? "Assistant"
              : "Message";
        const content = String(msg.content);
        parts.push({ type: "text", text: `${role}: ${content}` });
      }
    }

    const slashIdx = this.modelId.indexOf("/");
    const model =
      slashIdx >= 0
        ? {
            providerID: this.modelId.slice(0, slashIdx),
            modelID: this.modelId.slice(slashIdx + 1),
          }
        : undefined;

    const promptResp = await client.session.prompt({
      path: { id: sessionId },
      body: {
        parts,
        ...(model ? { model } : {}),
        ...(system ? { system } : {}),
      },
    });
    if (!promptResp?.data) {
      throw new Error("OpenCode prompt returned no response");
    }
    const responseParts: Part[] = promptResp.data.parts;
    const textPart = responseParts.find(
      (p): p is Part & { type: "text"; text: string } => p.type === "text",
    );
    const text = textPart ? textPart.text : "";

    return {
      generations: [
        {
          text,
          message: new AIMessage(text),
        },
      ],
    };
  }

  _llmType(): string {
    return "opencode";
  }
}
