import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { UPDATE_METADATA_PATH } from "../../src/config/constants.ts";
import {
  WIKI_WORKSPACES_FILE,
  clearActiveWikiWorkspace,
  discoverRepositories,
  discoverRepositoriesFromPath,
  listWikiWorkspaces,
  listWorkspaceWikis,
  readWikiWorkspaceRegistry,
  resolveReadableWiki,
  resolveWikiSearchScope,
  saveWikiWorkspaces,
  setActiveWikiWorkspace,
  workspaceDrafts,
  type WikiWorkspaceStorageOptions,
  type DiscoveredRepository,
} from "../../src/linking/wiki-workspaces.ts";

/**
 * Temporary roots removed after each test.
 */
const temporaryRoots: string[] = [];

/**
 * Valid registry text size that exceeds the production two-megabyte limit.
 */
const OVERSIZED_REGISTRY_BYTES = 2 * 1024 * 1024 + 1;

/**
 * Creates an isolated directory and records it for cleanup.
 *
 * @param prefix - Temporary directory name prefix.
 * @returns Absolute temporary root.
 */
async function createTemporaryRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  temporaryRoots.push(root);
  return root;
}

/**
 * Creates the minimum markers for one linkable repository wiki.
 *
 * @param parent - Directory receiving the repository.
 * @param relativePath - Repository path below the parent.
 * @returns Absolute repository root.
 */
async function createWikiRepository(
  parent: string,
  relativePath: string,
): Promise<string> {
  const root = path.join(parent, relativePath);
  await mkdir(path.join(root, ".git"), { recursive: true });
  await mkdir(path.join(root, "openwiki"), { recursive: true });
  await writeFile(
    path.join(root, "openwiki", "quickstart.md"),
    `# ${relativePath}\n`,
    "utf8",
  );
  await writeFile(path.join(root, UPDATE_METADATA_PATH), "{}\n", "utf8");
  return root;
}

/**
 * Creates an isolated workspace-registry storage override.
 *
 * @returns Storage options rooted in a temporary directory.
 */
async function createStorage(): Promise<WikiWorkspaceStorageOptions> {
  return { configDirectory: await createTemporaryRoot("openwiki-config-") };
}

/**
 * Collects streamed repository discovery for deterministic assertions.
 *
 * @param repositories - Streaming discovery result.
 * @returns Repositories in discovery order.
 */
async function collectRepositories(
  repositories: AsyncIterable<DiscoveredRepository>,
): Promise<DiscoveredRepository[]> {
  const collected: DiscoveredRepository[] = [];
  for await (const repository of repositories) collected.push(repository);
  return collected;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("wiki workspaces", () => {
  test("streams repositories and resolves partial finder paths", async () => {
    const directory = await createTemporaryRoot("openwiki-discovery-");
    const control = await createWikiRepository(directory, "control-plane");
    const openwiki = await createWikiRepository(directory, "openwiki");
    await createWikiRepository(directory, "services/data-plane");
    await createWikiRepository(directory, "node_modules/not-a-service");
    const quickstartOnly = path.join(directory, "quickstart-only");
    await mkdir(path.join(quickstartOnly, ".git"), { recursive: true });
    await mkdir(path.join(quickstartOnly, "openwiki"), { recursive: true });
    await writeFile(
      path.join(quickstartOnly, "openwiki", "quickstart.md"),
      "# Not initialized\n",
      "utf8",
    );
    await expect(
      collectRepositories(discoverRepositories(directory)),
    ).resolves.toEqual([
      {
        root: control,
        name: "control-plane",
        path: "control-plane",
        hasOpenWiki: true,
      },
      {
        root: openwiki,
        name: "openwiki",
        path: "openwiki",
        hasOpenWiki: true,
      },
      {
        root: quickstartOnly,
        name: "quickstart-only",
        path: "quickstart-only",
        hasOpenWiki: false,
      },
      {
        root: path.join(directory, "services/data-plane"),
        name: "data-plane",
        path: "services/data-plane",
        hasOpenWiki: true,
      },
    ]);
    await expect(
      collectRepositories(
        discoverRepositoriesFromPath(path.join(directory, "services", "data")),
      ),
    ).resolves.toEqual([
      {
        root: path.join(directory, "services/data-plane"),
        name: "data-plane",
        path: "data-plane",
        hasOpenWiki: true,
      },
    ]);
  });

  test("persists overlapping workspaces across unrelated locations", async () => {
    const firstLocation = await createTemporaryRoot("openwiki-services-");
    const secondLocation = await createTemporaryRoot("openwiki-infra-");
    const storage = await createStorage();
    const control = await createWikiRepository(firstLocation, "control");
    const data = await createWikiRepository(firstLocation, "data");
    const analytics = await createWikiRepository(firstLocation, "analytics");
    const infra = await createWikiRepository(secondLocation, "shared-infra");

    const registry = await saveWikiWorkspaces(
      [
        { name: "Payments", roots: [control, data, infra] },
        { name: "Analytics", roots: [analytics, infra] },
      ],
      storage,
    );

    expect(registry.workspaces).toEqual([
      {
        id: "analytics",
        name: "Analytics",
        wikis: ["analytics", "shared-infra"],
      },
      {
        id: "payments",
        name: "Payments",
        wikis: ["control", "data", "shared-infra"],
      },
    ]);
    await expect(
      listWikiWorkspaces(infra, undefined, storage),
    ).resolves.toEqual({
      wiki: { id: "shared-infra", name: "shared-infra" },
      workspaces: [
        { id: "analytics", name: "Analytics", wikiCount: 2 },
        { id: "payments", name: "Payments", wikiCount: 3 },
      ],
    });
    await expect(
      listWorkspaceWikis(data, "Payments", storage),
    ).resolves.toEqual({
      workspace: { id: "payments", name: "Payments", wikiCount: 3 },
      wikis: [
        { id: "control", name: "control" },
        { id: "data", name: "data" },
        { id: "shared-infra", name: "shared-infra" },
      ],
    });
    const registryMode = (
      await lstat(path.join(storage.configDirectory!, WIKI_WORKSPACES_FILE))
    ).mode;
    expect(registryMode & 0o777).toBe(0o600);
  });

  test("applies standalone, sole, ambiguous, active, and explicit resolution", async () => {
    const directory = await createTemporaryRoot("openwiki-resolution-");
    const storage = await createStorage();
    const standalone = await createWikiRepository(directory, "standalone");
    const shared = await createWikiRepository(directory, "shared");
    const payments = await createWikiRepository(directory, "payments");
    const platform = await createWikiRepository(directory, "platform");

    await expect(
      resolveWikiSearchScope(standalone, undefined, storage),
    ).resolves.toMatchObject({
      status: "ready",
      current: { id: "standalone" },
      wikis: [{ id: "standalone", root: standalone }],
    });

    await saveWikiWorkspaces(
      [{ name: "Payments", roots: [shared, payments] }],
      storage,
    );
    await expect(
      resolveWikiSearchScope(shared, undefined, storage),
    ).resolves.toMatchObject({
      status: "ready",
      workspace: { id: "payments" },
    });

    await saveWikiWorkspaces(
      [
        { name: "Payments", roots: [shared, payments] },
        { name: "Platform", roots: [shared, platform] },
      ],
      storage,
    );
    await expect(
      resolveWikiSearchScope(shared, undefined, storage),
    ).resolves.toEqual({
      status: "workspace_required",
      wiki: { id: "shared", name: "shared" },
      workspaces: [
        { id: "payments", name: "Payments", wikiCount: 2 },
        { id: "platform", name: "Platform", wikiCount: 2 },
      ],
    });

    await setActiveWikiWorkspace(shared, "platform", storage);
    await expect(
      resolveWikiSearchScope(shared, undefined, storage),
    ).resolves.toMatchObject({
      status: "ready",
      workspace: { id: "platform" },
    });
    await expect(
      resolveWikiSearchScope(shared, "Payments", storage),
    ).resolves.toMatchObject({
      status: "ready",
      workspace: { id: "payments" },
    });

    await expect(clearActiveWikiWorkspace(shared, storage)).resolves.toBe(true);
    await expect(clearActiveWikiWorkspace(shared, storage)).resolves.toBe(
      false,
    );
  });

  test("does not authorize an unregistered repository by a colliding local ID", async () => {
    const directory = await createTemporaryRoot("openwiki-collision-");
    const storage = await createStorage();
    const registered = await createWikiRepository(
      directory,
      "registered/control-plane",
    );
    const peer = await createWikiRepository(directory, "registered/data-plane");
    const unregistered = await createWikiRepository(
      directory,
      "unregistered/control-plane",
    );
    await saveWikiWorkspaces(
      [{ name: "Payments", roots: [registered, peer] }],
      storage,
    );

    await expect(
      listWikiWorkspaces(unregistered, undefined, storage),
    ).resolves.toEqual({
      wiki: { id: "control-plane", name: "control-plane" },
      workspaces: [],
    });
    await expect(
      resolveWikiSearchScope(unregistered, undefined, storage),
    ).resolves.toEqual({
      status: "ready",
      current: { id: "control-plane", name: "control-plane" },
      wikis: [
        {
          id: "control-plane",
          name: "control-plane",
          root: unregistered,
        },
      ],
    });
    await expect(
      resolveReadableWiki(unregistered, undefined, storage),
    ).resolves.toEqual({
      id: "control-plane",
      name: "control-plane",
      root: unregistered,
    });

    const registrationError = "not registered in a wiki workspace";
    await expect(
      listWikiWorkspaces(unregistered, "control-plane", storage),
    ).rejects.toThrow(registrationError);
    await expect(
      listWorkspaceWikis(unregistered, "payments", storage),
    ).rejects.toThrow(registrationError);
    await expect(
      resolveWikiSearchScope(unregistered, "payments", storage),
    ).rejects.toThrow(registrationError);
    await expect(
      resolveReadableWiki(unregistered, "control-plane", storage),
    ).rejects.toThrow(registrationError);
    await expect(
      resolveReadableWiki(unregistered, "data-plane", storage),
    ).rejects.toThrow(registrationError);
    await expect(
      setActiveWikiWorkspace(unregistered, "payments", storage),
    ).rejects.toThrow(registrationError);

    await setActiveWikiWorkspace(registered, "payments", storage);
    await expect(
      clearActiveWikiWorkspace(unregistered, storage),
    ).rejects.toThrow(registrationError);
    await expect(readWikiWorkspaceRegistry(storage)).resolves.toMatchObject({
      active: [{ wiki: "control-plane", workspace: "payments" }],
    });
  });

  test("retains stable IDs across edits and removes invalid active selections", async () => {
    const directory = await createTemporaryRoot("openwiki-edits-");
    const storage = await createStorage();
    const first = await createWikiRepository(directory, "first");
    const second = await createWikiRepository(directory, "second");
    const third = await createWikiRepository(directory, "third");
    const initial = await saveWikiWorkspaces(
      [{ name: "Payments", roots: [first, second] }],
      storage,
    );
    await setActiveWikiWorkspace(first, "payments", storage);

    const drafts = workspaceDrafts(initial);
    drafts[0].name = "Payment Service";
    drafts[0].roots = [first, third];
    const updated = await saveWikiWorkspaces(drafts, storage);

    expect(updated.workspaces[0]).toMatchObject({
      id: "payments",
      name: "Payment Service",
      wikis: ["first", "third"],
    });
    expect(updated.active).toEqual([{ wiki: "first", workspace: "payments" }]);
    expect(updated.wikis.some((wiki) => wiki.id === "second")).toBe(false);
  });

  test("reserves retained IDs before assigning colliding new repositories", async () => {
    const directory = await createTemporaryRoot("openwiki-identities-");
    const storage = await createStorage();
    const retainedApi = await createWikiRepository(directory, "z-team/api");
    const newApi = await createWikiRepository(directory, "a-team/api");
    const infra = await createWikiRepository(directory, "infra");
    const initial = await saveWikiWorkspaces(
      [{ name: "Services", roots: [retainedApi, infra] }],
      storage,
    );

    await saveWikiWorkspaces(
      [
        {
          id: initial.workspaces[0].id,
          name: "Services",
          roots: [newApi, retainedApi, infra],
        },
      ],
      storage,
    );
    const updated = await readWikiWorkspaceRegistry(storage);

    expect(updated.wikis.find((wiki) => wiki.root === retainedApi)?.id).toBe(
      "api",
    );
    expect(updated.wikis.find((wiki) => wiki.root === newApi)?.id).toBe(
      "api-2",
    );
  });

  test("rejects malformed registries and stale selected repositories", async () => {
    const directory = await createTemporaryRoot("openwiki-invalid-");
    const storage = await createStorage();
    const first = await createWikiRepository(directory, "first");
    const second = await createWikiRepository(directory, "second");
    await writeFile(
      path.join(storage.configDirectory!, WIKI_WORKSPACES_FILE),
      JSON.stringify({
        version: 1,
        wikis: [],
        workspaces: [],
        active: [],
        extra: true,
      }),
      "utf8",
    );
    await expect(readWikiWorkspaceRegistry(storage)).rejects.toThrow("invalid");

    await rm(path.join(storage.configDirectory!, WIKI_WORKSPACES_FILE));
    await saveWikiWorkspaces(
      [{ name: "Services", roots: [first, second] }],
      storage,
    );
    await rm(second, { recursive: true });
    await expect(
      resolveWikiSearchScope(first, undefined, storage),
    ).rejects.toThrow("unavailable repository wiki");
  });

  test("rejects an oversized registry before accepting valid JSON", async () => {
    const storage = await createStorage();
    const registry = JSON.stringify({
      version: 1,
      wikis: [],
      workspaces: [],
      active: [],
    });
    await writeFile(
      path.join(storage.configDirectory!, WIKI_WORKSPACES_FILE),
      registry.padEnd(OVERSIZED_REGISTRY_BYTES, " "),
      "utf8",
    );

    await expect(readWikiWorkspaceRegistry(storage)).rejects.toThrow("invalid");
  });

  test.skipIf(process.platform === "win32")(
    "rejects a workspace registry reached through a symlink",
    async () => {
      const storage = await createStorage();
      const externalDirectory = await createTemporaryRoot(
        "openwiki-external-registry-",
      );
      const externalRegistry = path.join(
        externalDirectory,
        WIKI_WORKSPACES_FILE,
      );
      await writeFile(
        externalRegistry,
        JSON.stringify({
          version: 1,
          wikis: [],
          workspaces: [],
          active: [],
        }),
        "utf8",
      );
      await symlink(
        externalRegistry,
        path.join(storage.configDirectory!, WIKI_WORKSPACES_FILE),
      );

      await expect(readWikiWorkspaceRegistry(storage)).rejects.toThrow(
        "invalid",
      );
    },
  );
});
