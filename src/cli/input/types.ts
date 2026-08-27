import type { OpenWikiProvider } from "../../config/constants.js";
import type { ReasoningEffort } from "../../config/reasoning.js";

/**
 * The editable state of the chat text input: the current `value` and the
 * `cursorPosition` (a character offset in `[0, value.length]`) the next edit
 * acts on.
 */
export interface ChatInputState {
  /**
   * Character offset of the caret within `value`.
   */
  cursorPosition: number;

  /**
   * The current input text.
   */
  value: string;
}

/**
 * Active secret-capture mode for the input: the input is masked and the typed
 * value is routed to a specific credential env var rather than the chat.
 */
export interface SecretInputMode {
  /**
   * The env var the captured secret is written to (e.g. `ANTHROPIC_API_KEY`).
   */
  envKey: string;

  /**
   * Which secret is being captured, so the handler knows how to persist it.
   */
  kind: "api-key" | "langsmith-key";

  /**
   * Human-readable label shown in the masked prompt.
   */
  label: string;

  /**
   * The provider the key belongs to, for provider-scoped secrets.
   *
   * @default undefined - the secret is not provider-scoped (e.g. a LangSmith
   * key), so no provider is associated.
   */
  provider?: OpenWikiProvider;
}

/**
 * Which selection menu, if any, the input is currently showing. The active
 * variant carries the highlighted `selectedIndex`; `none` means the input is in
 * ordinary text-entry mode.
 */
export type ChatInputMenuState =
  | { kind: "commands"; selectedIndex: number }
  | { kind: "effort"; selectedIndex: number }
  | { kind: "model"; selectedIndex: number }
  | { kind: "provider"; selectedIndex: number }
  | { kind: "none" };

/**
 * The closed set of slash commands the input recognizes.
 */
export type SlashCommandId =
  | "api-key"
  | "clear"
  | "effort"
  | "exit"
  | "help"
  | "init"
  | "langsmith-key"
  | "model"
  | "provider"
  | "update";

/**
 * A single slash command as shown in the command menu.
 */
export interface SlashCommandOption {
  /**
   * One-line explanation shown next to the command.
   */
  description: string;

  /**
   * The command's stable identifier.
   */
  id: SlashCommandId;

  /**
   * The typed form, including the leading slash (e.g. `/model`).
   */
  label: string;
}

/** A row in the reasoning-effort selection menu. */
export type ReasoningEffortMenuOption =
  | {
      kind: "default";
      label: "Provider default";
    }
  | {
      effort: ReasoningEffort;
      kind: "effort";
      label: ReasoningEffort;
    };

/**
 * A row in the model-selection menu: either a concrete `model` id or the
 * `custom` sentinel that lets the user type an arbitrary model id.
 */
export type ModelMenuOption =
  | {
      kind: "model";
      label: string;
      modelId: string;
    }
  | {
      kind: "custom";
      label: string;
    };
