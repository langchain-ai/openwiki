import { ToolMessage } from "@langchain/core/messages";
import { isCommand } from "@langchain/langgraph";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createOrUpdateIndex } from "../src/agent/indexing/create-or-update-index-tool.ts";
import { OpenWikiLocalShellBackend } from "../src/agent/docs-only-backend.ts";
import { findPendingIndexes } from "../src/agent/indexing/get-pending-indexes-tool.ts";
import {
  addEditedPathUpdate,
  mergeEditedWikiPaths,
} from "../src/agent/indexing/state.ts";
import { MUTATION_PATH_METADATA_KEY } from "../src/agent/indexing/utils.ts";

const ROOT_INDEX = "/openwiki/index.md";
const ARCHITECTURE_INDEX = "/openwiki/architecture/index.md";

function documentContent(title: string, description: string): string {
  return `---\ntype: Reference\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n\n# Content\n`;
}

async function createTestBackend() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-index-"));
  const backend = new OpenWikiLocalShellBackend({
    docsOnly: true,
    outputMode: "repository",
    rootDir,
    virtualMode: true,
  });
  return { backend, rootDir };
}

describe("OpenWiki index state", () => {
  test("merges concurrent paths, deduplicates them, and resets per run", () => {
    expect(
      mergeEditedWikiPaths(
        ["/openwiki/a.md"],
        ["/openwiki/b.md", "/openwiki/a.md"],
      ),
    ).toEqual(["/openwiki/a.md", "/openwiki/b.md"]);
    expect(mergeEditedWikiPaths(["/openwiki/a.md"], [])).toEqual([]);
  });

  test("converts trusted mutation metadata into a state update", () => {
    const message = new ToolMessage({
      content: "written",
      metadata: { [MUTATION_PATH_METADATA_KEY]: "/openwiki/page.md" },
      tool_call_id: "write-1",
    });
    const result = addEditedPathUpdate(message);

    expect(isCommand(result)).toBe(true);
    if (!isCommand(result) || Array.isArray(result.update)) return;
    expect(result.update?.editedWikiPaths).toEqual(["/openwiki/page.md"]);
    expect(result.update?.messages).toEqual([message]);
  });
});

describe("OpenWiki index tools", () => {
  test("finds state-derived indexes deepest-first and renders them", async () => {
    const { backend, rootDir } = await createTestBackend();
    const editedPaths = [
      "/openwiki/architecture/overview.md",
      "/openwiki/architecture/providers/models.md",
    ];

    await backend.write(
      editedPaths[0],
      documentContent("Runtime overview", "How the runtime is assembled."),
    );
    await backend.write(
      editedPaths[1],
      documentContent("Model providers", "Supported model provider behavior."),
    );

    await expect(
      findPendingIndexes(backend, "repository", editedPaths),
    ).resolves.toEqual([
      {
        exists: false,
        path: "/openwiki/architecture/providers/index.md",
      },
      { exists: false, path: ARCHITECTURE_INDEX },
      { exists: false, path: ROOT_INDEX },
    ]);

    await createOrUpdateIndex(
      backend,
      "repository",
      "/openwiki/architecture/providers/index.md",
      "Model provider configuration and runtime behavior.",
    );
    await createOrUpdateIndex(
      backend,
      "repository",
      ARCHITECTURE_INDEX,
      "System structure, runtime components, and design boundaries.",
    );
    await createOrUpdateIndex(
      backend,
      "repository",
      ROOT_INDEX,
      "OpenWiki documentation and navigation.",
    );

    const index = await readFile(
      path.join(rootDir, "openwiki/architecture/index.md"),
      "utf8",
    );
    expect(index).toContain("type: Documentation Index");
    expect(index).toContain(
      "- [Runtime overview](overview.md) - How the runtime is assembled.",
    );
    expect(index).toContain(
      "- [Providers](providers/) - Model provider configuration and runtime behavior.",
    );
    expect(index).not.toMatch(/^tags:/mu);
    await expect(
      findPendingIndexes(backend, "repository", editedPaths),
    ).resolves.toEqual([]);
  });

  test("preserves omitted descriptions and updates an existing parent", async () => {
    const { backend, rootDir } = await createTestBackend();
    const editedPaths = ["/openwiki/architecture/overview.md"];
    await backend.write(
      editedPaths[0],
      documentContent("Overview", "Original file description."),
    );
    await createOrUpdateIndex(
      backend,
      "repository",
      ARCHITECTURE_INDEX,
      "Original directory description.",
    );
    await createOrUpdateIndex(
      backend,
      "repository",
      ROOT_INDEX,
      "Root documentation description.",
    );

    await backend.edit(
      editedPaths[0],
      "Original file description.",
      "Updated file description.",
    );
    await createOrUpdateIndex(
      backend,
      "repository",
      ARCHITECTURE_INDEX,
      "Updated directory description.",
    );

    expect(
      await readFile(path.join(rootDir, "openwiki/index.md"), "utf8"),
    ).toContain(
      "- [Architecture](architecture/) - Updated directory description.",
    );

    await backend.edit(
      editedPaths[0],
      "Updated file description.",
      "Newest file description.",
    );
    await createOrUpdateIndex(backend, "repository", ARCHITECTURE_INDEX);
    expect(
      await readFile(
        path.join(rootDir, "openwiki/architecture/index.md"),
        "utf8",
      ),
    ).toContain('description: "Updated directory description."');
  });

  test("requires descriptions for new indexes and confines paths", async () => {
    const { backend } = await createTestBackend();
    const editedPaths = ["/openwiki/page.md"];
    await backend.write(
      editedPaths[0],
      documentContent("Page", "A page description."),
    );

    await expect(
      createOrUpdateIndex(backend, "repository", ROOT_INDEX),
    ).rejects.toThrow("A description is required");
    await expect(
      createOrUpdateIndex(
        backend,
        "repository",
        "/outside/index.md",
        "Outside.",
      ),
    ).rejects.toThrow("inside /openwiki");
    await expect(
      createOrUpdateIndex(
        backend,
        "repository",
        "/openwiki/../index.md",
        "Traversal.",
      ),
    ).rejects.toThrow("Invalid virtual path");
  });

  test("omits indexes when a body-only edit leaves metadata unchanged", async () => {
    const { backend } = await createTestBackend();
    const editedPaths = ["/openwiki/page.md"];
    await backend.write(
      editedPaths[0],
      `${documentContent("Page", "A page description.")}Original body.\n`,
    );
    await createOrUpdateIndex(
      backend,
      "repository",
      ROOT_INDEX,
      "Root documentation description.",
    );
    await backend.edit(editedPaths[0], "Original body.", "Updated body.");

    await expect(
      findPendingIndexes(backend, "repository", editedPaths),
    ).resolves.toEqual([]);
  });
});
