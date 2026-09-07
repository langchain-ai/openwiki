import { REFLECTION_CAPTURE_GUIDANCE } from "../../generation/reflection-guidance.js";
import { ReflectionError, ReflectionStore } from "../../memory/reflections.js";
import { HostIntegrationError } from "./errors.js";
import { ReflectInput, type ProtocolTool } from "./protocol.js";
import { resolveRepositoryRoot } from "./repository-root.js";

/**
 * Builds the independent creation tool for pending repository discoveries.
 *
 * @returns A tool that captures evidence versions and publishes one UUID-named file.
 */
export function createReflectionTool(): ProtocolTool {
  return {
    name: "openwiki_reflect",
    description: `${REFLECTION_CAPTURE_GUIDANCE}

Supply a finding and repository evidence; OpenWiki captures evidence versions
and returns the ID and path of a new pending reflection that can travel with
a PR. Reflections are provisional, immediately retrievable, and require no
generation run. Each call creates a new file.`,
    schema: ReflectInput,
    handle: async (input) => {
      const { root: candidate, ...proposal } = ReflectInput.parse(input);
      const root = await resolveRepositoryRoot(candidate);
      try {
        return await new ReflectionStore(root).create(proposal);
      } catch (error) {
        if (error instanceof ReflectionError)
          throw new HostIntegrationError("invalid_input", error.message);
        throw new HostIntegrationError(
          "invalid_state",
          "The reflection could not be recorded. Check source visibility and repository permissions, then retry openwiki_reflect.",
        );
      }
    },
  };
}
