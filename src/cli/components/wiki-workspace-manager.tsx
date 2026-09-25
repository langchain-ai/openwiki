import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type {
  DiscoveredRepository,
  WikiWorkspaceDraft,
} from "../../linking/wiki-workspaces.js";

/**
 * Maximum filtered repository rows rendered at once.
 */
const MAX_VISIBLE_REPOSITORIES = 14;

/**
 * Properties accepted by the interactive wiki-workspace manager.
 */
export interface WikiWorkspaceManagerProps {
  /**
   * Complete persisted workspace collection when the manager opens.
   */
  initialWorkspaces: readonly WikiWorkspaceDraft[];

  /**
   * Canonical directory shown as the repository-finder scope.
   */
  finderRoot: string;

  /**
   * Creates one streaming scan for the current editable finder path.
   */
  findRepositories: (
    finderPath: string,
    signal: AbortSignal,
  ) => AsyncIterable<DiscoveredRepository>;

  /**
   * Receives the complete final workspace collection on Finish.
   */
  onSubmit: (workspaces: WikiWorkspaceDraft[]) => void;

  /**
   * Records an explicit Ctrl-C cancellation before exit.
   */
  onCancel: () => void;
}

/**
 * Manager-only workspace with a stable React list key.
 */
interface ManagedWorkspace extends WikiWorkspaceDraft {
  /**
   * Stable existing ID or temporary local identity.
   */
  key: string;
}

/**
 * Top-level saved-workspace list screen.
 */
interface WorkspaceListScreen {
  /**
   * Screen discriminator.
   */
  kind: "workspaces";
}

/**
 * Action menu for one selected workspace.
 */
interface WorkspaceActionsScreen {
  /**
   * Screen discriminator.
   */
  kind: "actions";

  /**
   * Manager identity of the selected workspace.
   */
  workspaceKey: string;
}

/**
 * Exact wiki-membership editor for one workspace.
 */
interface WorkspaceEditScreen {
  /**
   * Screen discriminator.
   */
  kind: "edit";

  /**
   * Manager identity of the selected workspace.
   */
  workspaceKey: string;
}

/**
 * Destructive confirmation screen for one workspace.
 */
interface WorkspaceDeleteScreen {
  /**
   * Screen discriminator.
   */
  kind: "delete";

  /**
   * Manager identity of the selected workspace.
   */
  workspaceKey: string;
}

/**
 * Workspace creation or rename text-entry screen.
 */
interface WorkspaceNameScreen {
  /**
   * Screen discriminator.
   */
  kind: "name";

  /**
   * Whether the submitted name creates or renames a workspace.
   */
  mode: "create" | "rename";

  /**
   * Existing workspace identity required by rename mode.
   */
  workspaceKey?: string;
}

/**
 * Complete top-level workspace-manager screen state.
 */
type ManagerScreen =
  | WorkspaceListScreen
  | WorkspaceActionsScreen
  | WorkspaceEditScreen
  | WorkspaceDeleteScreen
  | WorkspaceNameScreen;

/**
 * One selectable row in the workspace member editor.
 */
interface EditorRow {
  /**
   * Row behavior discriminator.
   */
  kind: "selected" | "repository" | "save" | "back";

  /**
   * Repository associated with a selected or finder row.
   */
  repository?: DiscoveredRepository;

  /**
   * Whether a finder result is also present in the pinned selection.
   */
  selected?: boolean;
}

/**
 * Editor row paired with its cursor index before visual grouping.
 */
interface IndexedEditorRow {
  /**
   * Repository or action row.
   */
  row: EditorRow;

  /**
   * Stable position in the complete navigable row collection.
   */
  index: number;
}

/**
 * Interactive manager used by `openwiki link`.
 *
 * @param props - Initial state, discovery callback, and completion callbacks.
 * @returns Ink workspace manager view.
 */
export function WikiWorkspaceManager({
  initialWorkspaces,
  finderRoot,
  findRepositories,
  onSubmit,
  onCancel,
}: WikiWorkspaceManagerProps): React.JSX.Element {
  const { exit } = useApp();
  const [workspaces, setWorkspaces] = useState<ManagedWorkspace[]>(() =>
    initialWorkspaces.map((workspace) => ({
      ...workspace,
      roots: [...workspace.roots],
      key: workspace.id ?? temporaryWorkspaceKey(),
    })),
  );
  const [knownRepositories, setKnownRepositories] = useState<
    DiscoveredRepository[]
  >(() => workspaceRepositories(initialWorkspaces));
  const [scannedRepositories, setScannedRepositories] = useState<
    DiscoveredRepository[]
  >([]);
  const [finderPath, setFinderPath] = useState(() =>
    displayRepositoryPath(finderRoot),
  );
  const [screen, setScreen] = useState<ManagerScreen>({ kind: "workspaces" });
  const [cursor, setCursor] = useState(0);
  const [input, setInput] = useState("");
  const [editRoots, setEditRoots] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [scanning, setScanning] = useState(true);

  const selectedWorkspace =
    "workspaceKey" in screen
      ? workspaces.find((workspace) => workspace.key === screen.workspaceKey)
      : undefined;
  const repositories = useMemo(
    () => mergeRepositories(knownRepositories, scannedRepositories),
    [knownRepositories, scannedRepositories],
  );
  const editorRows = useMemo<EditorRow[]>(
    () => createEditorRows(repositories, editRoots, finderPath),
    [editRoots, finderPath, repositories],
  );

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    /**
     * Consumes repository discovery incrementally without delaying first render.
     */
    async function scanRepositories(): Promise<void> {
      try {
        setScanning(true);
        setScannedRepositories([]);
        for await (const repository of findRepositories(
          finderPath,
          controller.signal,
        )) {
          if (!active) return;
          setScannedRepositories((current) =>
            mergeRepositories(current, [repository]),
          );
        }
      } catch (error) {
        if (active) {
          setMessage(
            error instanceof Error
              ? error.message
              : "Unable to search for repositories.",
          );
        }
      } finally {
        if (active) setScanning(false);
      }
    }

    void scanRepositories();
    return () => {
      active = false;
      controller.abort();
    };
  }, [findRepositories, finderPath]);

  /**
   * Returns to a screen with reset navigation feedback.
   *
   * @param next - Destination manager screen.
   */
  function navigate(next: ManagerScreen): void {
    setScreen(next);
    setCursor(0);
    setInput("");
    setMessage(null);
  }

  /**
   * Opens the member editor with an isolated selection draft.
   *
   * @param workspace - Workspace whose exact membership should be edited.
   */
  function beginEditing(workspace: ManagedWorkspace): void {
    setEditRoots(new Set(workspace.roots));
    navigate({ kind: "edit", workspaceKey: workspace.key });
  }

  /**
   * Completes workspace creation or rename from the current text input.
   */
  function submitName(): void {
    const name = input.trim();
    if (!validWorkspaceName(name)) {
      setMessage("Enter a workspace name of 80 characters or fewer.");
      return;
    }
    const duplicate = workspaces.some(
      (workspace) =>
        workspace.key !== screenWorkspaceKey(screen) &&
        workspace.name.toLowerCase() === name.toLowerCase(),
    );
    if (duplicate) {
      setMessage("Workspace names must be unique.");
      return;
    }

    if (
      screen.kind === "name" &&
      screen.mode === "rename" &&
      screen.workspaceKey
    ) {
      setWorkspaces((current) =>
        current.map((workspace) =>
          workspace.key === screen.workspaceKey
            ? { ...workspace, name }
            : workspace,
        ),
      );
      navigate({ kind: "actions", workspaceKey: screen.workspaceKey });
      return;
    }

    const key = temporaryWorkspaceKey();
    const workspace: ManagedWorkspace = { key, name, roots: [] };
    setWorkspaces((current) => [...current, workspace]);
    setEditRoots(new Set());
    navigate({ kind: "edit", workspaceKey: key });
  }

  /**
   * Toggles a selectable repository row or explains why it is unavailable.
   *
   * @param row - Active selected or finder row.
   */
  function chooseRepository(row: EditorRow | undefined): void {
    if (!row?.repository) return;
    if (row.kind === "repository" && !row.repository.hasOpenWiki) {
      setMessage("This repository does not contain OpenWiki documentation.");
      return;
    }
    if (row.kind !== "selected" && row.kind !== "repository") return;
    const wasSelected = editRoots.has(row.repository.root);
    if (!wasSelected) {
      setKnownRepositories((current) =>
        mergeRepositories(current, [row.repository!]),
      );
    }
    setEditRoots((current) => toggleSelection(current, row.repository!.root));
    if (row.kind === "repository") {
      setCursor((current) => Math.max(0, current + (wasSelected ? -1 : 1)));
    }
    setMessage(null);
  }

  useInput((inputValue, key) => {
    if (key.ctrl && inputValue === "c") {
      onCancel();
      exit();
      return;
    }

    if (screen.kind === "name") {
      if (key.escape) {
        if (screen.mode === "rename" && screen.workspaceKey) {
          navigate({ kind: "actions", workspaceKey: screen.workspaceKey });
        } else {
          navigate({ kind: "workspaces" });
        }
        return;
      }
      if (key.return) {
        submitName();
        return;
      }
      if (key.backspace || key.delete) {
        setInput((current) => current.slice(0, -1));
        setMessage(null);
        return;
      }
      if (!key.ctrl && !key.meta) {
        const printable = printableInput(inputValue);
        if (printable) {
          setInput((current) => `${current}${printable}`.slice(0, 2_000));
          setMessage(null);
        }
      }
      return;
    }

    const rowCount = managerRowCount(screen, workspaces, editorRows);
    if (key.upArrow || (screen.kind !== "edit" && inputValue === "k")) {
      setCursor((current) => wrapIndex(current - 1, rowCount));
      setMessage(null);
      return;
    }
    if (key.downArrow || (screen.kind !== "edit" && inputValue === "j")) {
      setCursor((current) => wrapIndex(current + 1, rowCount));
      setMessage(null);
      return;
    }

    if (screen.kind === "edit") {
      if (key.backspace || key.delete) {
        setFinderPath(backspaceFinderPath);
        setCursor(editRoots.size);
        setMessage(null);
        return;
      }
      if (inputValue === " ") {
        chooseRepository(editorRows[cursor]);
        return;
      }
      if (!key.return && !key.ctrl && !key.meta) {
        const printable = printableInput(inputValue);
        if (printable) {
          setFinderPath((current) => `${current}${printable}`.slice(0, 2_000));
          setCursor(editRoots.size);
          setMessage(null);
        }
        return;
      }
    }
    if (!key.return) return;

    if (screen.kind === "workspaces") {
      if (cursor < workspaces.length) {
        navigate({ kind: "actions", workspaceKey: workspaces[cursor].key });
      } else if (cursor === workspaces.length) {
        navigate({ kind: "name", mode: "create" });
      } else {
        onSubmit(workspaces.map(managerDraft));
        exit();
      }
      return;
    }

    if (!selectedWorkspace) {
      navigate({ kind: "workspaces" });
      return;
    }
    if (screen.kind === "actions") {
      if (cursor === 0) beginEditing(selectedWorkspace);
      else if (cursor === 1) {
        setInput(selectedWorkspace.name);
        setScreen({
          kind: "name",
          mode: "rename",
          workspaceKey: selectedWorkspace.key,
        });
        setCursor(0);
        setMessage(null);
      } else if (cursor === 2) {
        navigate({ kind: "delete", workspaceKey: selectedWorkspace.key });
      } else navigate({ kind: "workspaces" });
      return;
    }
    if (screen.kind === "delete") {
      if (cursor === 0) {
        setWorkspaces((current) =>
          current.filter(
            (workspace) => workspace.key !== selectedWorkspace.key,
          ),
        );
        navigate({ kind: "workspaces" });
      } else navigate({ kind: "actions", workspaceKey: selectedWorkspace.key });
      return;
    }
    if (screen.kind === "edit") {
      const row = editorRows[cursor];
      if (row?.kind === "selected" || row?.kind === "repository") {
        chooseRepository(row);
      } else if (row?.kind === "save") {
        if (editRoots.size < 2) {
          setMessage(
            "Select at least two repositories with OpenWiki documentation.",
          );
          return;
        }
        setWorkspaces((current) =>
          current.map((workspace) =>
            workspace.key === selectedWorkspace.key
              ? { ...workspace, roots: [...editRoots] }
              : workspace,
          ),
        );
        navigate({ kind: "actions", workspaceKey: selectedWorkspace.key });
      } else if (row?.kind === "back") {
        if (selectedWorkspace.roots.length === 0 && !selectedWorkspace.id) {
          setWorkspaces((current) =>
            current.filter(
              (workspace) => workspace.key !== selectedWorkspace.key,
            ),
          );
          navigate({ kind: "workspaces" });
        } else {
          navigate({ kind: "actions", workspaceKey: selectedWorkspace.key });
        }
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>Wiki workspaces</Text>
      {screen.kind === "workspaces" ? (
        <WorkspaceList workspaces={workspaces} cursor={cursor} />
      ) : null}
      {screen.kind === "actions" && selectedWorkspace ? (
        <WorkspaceActions workspace={selectedWorkspace} cursor={cursor} />
      ) : null}
      {screen.kind === "edit" && selectedWorkspace ? (
        <WorkspaceEditor
          workspace={selectedWorkspace}
          rows={editorRows}
          cursor={cursor}
          finderPath={finderPath}
          scanning={scanning}
        />
      ) : null}
      {screen.kind === "delete" && selectedWorkspace ? (
        <DeleteConfirmation workspace={selectedWorkspace} cursor={cursor} />
      ) : null}
      {screen.kind === "name" ? (
        <TextEntry
          label={
            screen.mode === "create" ? "Workspace name" : "Rename workspace"
          }
          value={input}
        />
      ) : null}
      {message ? <Text color="yellow">{message}</Text> : null}
      <Box marginTop={1}>
        <Text dimColor>{footerForScreen(screen)}</Text>
      </Box>
    </Box>
  );
}

/**
 * Properties accepted by the top-level workspace list.
 */
interface WorkspaceListProps {
  /**
   * Current manager workspaces.
   */
  workspaces: readonly ManagedWorkspace[];

  /**
   * Selected row index.
   */
  cursor: number;
}

/**
 * Renders existing workspaces plus Create and Finish actions.
 *
 * @param props - Workspaces and selected row.
 * @returns Ink list view.
 */
function WorkspaceList({
  workspaces,
  cursor,
}: WorkspaceListProps): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      {workspaces.map((workspace, index) => (
        <MenuText key={workspace.key} active={cursor === index}>
          {workspace.name} <Text dimColor>{workspace.roots.length} wikis</Text>
        </MenuText>
      ))}
      <MenuText active={cursor === workspaces.length}>
        Create workspace
      </MenuText>
      <MenuText active={cursor === workspaces.length + 1}>Finish</MenuText>
    </Box>
  );
}

/**
 * Properties accepted by the workspace action menu.
 */
interface WorkspaceActionsProps {
  /**
   * Selected workspace.
   */
  workspace: ManagedWorkspace;

  /**
   * Selected action index.
   */
  cursor: number;
}

/**
 * Renders edit, rename, delete, and back actions for one workspace.
 *
 * @param props - Selected workspace and action row.
 * @returns Ink action view.
 */
function WorkspaceActions({
  workspace,
  cursor,
}: WorkspaceActionsProps): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{workspace.name}</Text>
      {["Edit wikis", "Rename", "Delete", "Back"].map((label, index) => (
        <MenuText key={label} active={cursor === index}>
          {label}
        </MenuText>
      ))}
    </Box>
  );
}

/**
 * Properties accepted by the workspace member editor.
 */
interface WorkspaceEditorProps {
  /**
   * Workspace being edited.
   */
  workspace: ManagedWorkspace;

  /**
   * Candidate and action rows.
   */
  rows: readonly EditorRow[];

  /**
   * Selected row index across pinned, finder, and action rows.
   */
  cursor: number;

  /**
   * Complete editable repository discovery path.
   */
  finderPath: string;

  /**
   * Whether repository discovery is still producing results.
   */
  scanning: boolean;
}

/**
 * Renders repository membership selection and editor actions.
 *
 * @param props - Workspace, rows, selection, and cursor.
 * @returns Ink editor view.
 */
function WorkspaceEditor({
  workspace,
  rows,
  cursor,
  finderPath,
  scanning,
}: WorkspaceEditorProps): React.JSX.Element {
  const indexedRows = rows.map((row, index) => ({ row, index }));
  const selectedRows = indexedRows.filter(({ row }) => row.kind === "selected");
  const repositoryRows = indexedRows.filter(
    ({ row }) => row.kind === "repository",
  );
  const visibleRepositories = repositoryWindow(repositoryRows, cursor);
  const actionRows = indexedRows.filter(
    ({ row }) => row.kind === "save" || row.kind === "back",
  );

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{workspace.name}</Text>
      <Text dimColor>
        Select repositories whose OpenWiki documentation should be searched
        together.
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Text>Selected repositories</Text>
        {selectedRows.length === 0 ? (
          <Text dimColor> None selected</Text>
        ) : null}
        {selectedRows.map(({ row, index }) => (
          <RepositoryMenuRow
            key={`selected:${row.repository!.root}`}
            repository={row.repository!}
            active={cursor === index}
            selected
          />
        ))}
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">Path: {finderPath}_</Text>
          {visibleRepositories.map(({ row, index }) => (
            <RepositoryMenuRow
              key={`repository:${row.repository!.root}`}
              repository={row.repository!}
              active={cursor === index}
              selected={row.selected === true}
            />
          ))}
          {repositoryRows.length === 0 ? (
            <Text dimColor>
              {scanning ? "Searching…" : "No repositories match."}
            </Text>
          ) : null}
          {scanning && repositoryRows.length > 0 ? (
            <Text dimColor>Searching…</Text>
          ) : null}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {actionRows.map(({ row, index }) => (
            <MenuText key={row.kind} active={cursor === index}>
              {editorActionLabel(row.kind)}
            </MenuText>
          ))}
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Properties accepted by one repository finder or selected row.
 */
interface RepositoryMenuRowProps {
  /**
   * Repository displayed by the row.
   */
  repository: DiscoveredRepository;

  /**
   * Whether the row owns the keyboard cursor.
   */
  active: boolean;

  /**
   * Whether the repository is already selected.
   */
  selected: boolean;
}

/**
 * Renders one repository with selection and linkability conveyed unobtrusively.
 *
 * @param props - Repository, cursor, and selection state.
 * @returns One consistently styled repository row.
 */
function RepositoryMenuRow({
  repository,
  active,
  selected,
}: RepositoryMenuRowProps): React.JSX.Element {
  const selectable = selected || repository.hasOpenWiki;
  return (
    <MenuText active={active} dimmed={!selectable}>
      {selectable ? `${selected ? "●" : "○"} ` : "  "}
      {displayRepositoryPath(repository.root)}
    </MenuText>
  );
}

/**
 * Properties accepted by the delete confirmation view.
 */
interface DeleteConfirmationProps {
  /**
   * Workspace pending deletion.
   */
  workspace: ManagedWorkspace;

  /**
   * Selected confirmation row.
   */
  cursor: number;
}

/**
 * Renders an explicit destructive workspace-deletion confirmation.
 *
 * @param props - Workspace and confirmation row.
 * @returns Ink confirmation view.
 */
function DeleteConfirmation({
  workspace,
  cursor,
}: DeleteConfirmationProps): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>Delete {workspace.name}?</Text>
      <Text dimColor>
        The repositories and their documentation are not changed.
      </Text>
      <MenuText active={cursor === 0}>Delete workspace</MenuText>
      <MenuText active={cursor === 1}>Cancel</MenuText>
    </Box>
  );
}

/**
 * Properties accepted by one raw text-entry view.
 */
interface TextEntryProps {
  /**
   * Prompt label.
   */
  label: string;

  /**
   * Current plain-text value.
   */
  value: string;
}

/**
 * Renders one simple terminal text field.
 *
 * @param props - Prompt label and value.
 * @returns Ink text-entry view.
 */
function TextEntry({ label, value }: TextEntryProps): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{label}</Text>
      <Text color="cyan">› {value}_</Text>
    </Box>
  );
}

/**
 * Properties accepted by one consistently styled menu row.
 */
interface MenuTextProps {
  /**
   * Whether the row owns the cursor.
   */
  active: boolean;

  /**
   * Whether the row should remain visually subdued.
   */
  dimmed?: boolean;

  /**
   * Row content.
   */
  children: React.ReactNode;
}

/**
 * Renders one menu row with the shared cursor treatment.
 *
 * @param props - Active state and row content.
 * @returns Ink menu row.
 */
function MenuText({
  active,
  dimmed = false,
  children,
}: MenuTextProps): React.JSX.Element {
  return (
    <Text color={active ? "cyan" : undefined} dimColor={dimmed}>
      {active ? "›" : " "} {children}
    </Text>
  );
}

/**
 * Converts manager state back to a persistence draft.
 *
 * @param workspace - Manager-only workspace.
 * @returns Serializable workspace draft.
 */
function managerDraft(workspace: ManagedWorkspace): WikiWorkspaceDraft {
  return {
    ...(workspace.id ? { id: workspace.id } : {}),
    name: workspace.name,
    roots: [...workspace.roots],
  };
}

/**
 * Creates selectable repository entries for persisted workspace roots.
 *
 * @param workspaces - Persisted workspace drafts.
 * @returns Repository entries for every referenced root.
 */
function workspaceRepositories(
  workspaces: readonly WikiWorkspaceDraft[],
): DiscoveredRepository[] {
  return mergeRepositories(
    workspaces.flatMap((workspace) =>
      workspace.roots.map((root) => ({
        root,
        name: root.split(/[\\/]/u).at(-1) ?? root,
        path: root,
        hasOpenWiki: true,
      })),
    ),
  );
}

/**
 * Deduplicates repository roots and preserves positive OpenWiki detection.
 *
 * @param collections - Candidate collections to merge.
 * @returns Deterministically ordered unique repositories.
 */
function mergeRepositories(
  ...collections: readonly (readonly DiscoveredRepository[])[]
): DiscoveredRepository[] {
  const byRoot = new Map<string, DiscoveredRepository>();
  for (const collection of collections) {
    for (const repository of collection) {
      const existing = byRoot.get(repository.root);
      byRoot.set(repository.root, {
        ...repository,
        hasOpenWiki: repository.hasOpenWiki || existing?.hasOpenWiki === true,
      });
    }
  }
  return [...byRoot.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.root.localeCompare(right.root),
  );
}

/**
 * Builds pinned selections, ranked finder matches, and editor actions.
 *
 * @param repositories - Complete streamed and persisted repository collection.
 * @param selectedRoots - Canonical roots selected for the workspace draft.
 * @param finderPath - Complete editable repository path prefix.
 * @returns Complete navigable editor row collection.
 */
function createEditorRows(
  repositories: readonly DiscoveredRepository[],
  selectedRoots: ReadonlySet<string>,
  finderPath: string,
): EditorRow[] {
  const byRoot = new Map(
    repositories.map((repository) => [repository.root, repository]),
  );
  const selected = [...selectedRoots]
    .map(
      (root): DiscoveredRepository =>
        byRoot.get(root) ?? {
          root,
          name: root.split(/[\\/]/u).at(-1) ?? root,
          path: root,
          hasOpenWiki: true,
        },
    )
    .sort(compareRepositories);
  const matches = rankRepositories(repositories, finderPath);
  return [
    ...selected.map((repository) => ({
      kind: "selected" as const,
      repository,
      selected: true,
    })),
    ...matches.map((repository) => ({
      kind: "repository" as const,
      repository,
      selected: selectedRoots.has(repository.root),
    })),
    { kind: "save" },
    { kind: "back" },
  ];
}

/**
 * Ranks repositories whose paths begin with the composed finder path.
 *
 * @param repositories - Unselected repositories available to search.
 * @param finderPath - Complete editable repository path prefix.
 * @returns Matching repositories ordered by relevance then name and path.
 */
function rankRepositories(
  repositories: readonly DiscoveredRepository[],
  finderPath: string,
): DiscoveredRepository[] {
  const query = finderPath.trim().toLowerCase();
  if (!query) return [...repositories].sort(compareRepositories);
  return repositories
    .map((repository) => ({
      repository,
      score: pathPrefixScore(repository, query),
    }))
    .filter(
      (match): match is { repository: DiscoveredRepository; score: number } =>
        match.score !== null,
    )
    .sort(
      (left, right) =>
        left.score - right.score ||
        compareRepositories(left.repository, right.repository),
    )
    .map(({ repository }) => repository);
}

/**
 * Scores a path-like query against canonical, home-relative, and finder paths.
 *
 * @param repository - Repository candidate to score.
 * @param query - Normalized path-like search text.
 * @returns Prefix score, or `null` when no repository path starts with it.
 */
function pathPrefixScore(
  repository: DiscoveredRepository,
  query: string,
): number | null {
  const normalizedQuery = normalizeSearchPath(query);
  const displayed = normalizeSearchPath(
    displayRepositoryPath(repository.root).toLowerCase(),
  );
  const candidates = [
    displayed,
    normalizeSearchPath(repository.root.toLowerCase()),
    normalizeSearchPath(repository.path.toLowerCase()),
    ...(displayed.startsWith("~/") ? [displayed.slice(2)] : []),
  ];
  return candidates.some((candidate) => candidate.startsWith(normalizedQuery))
    ? 0
    : null;
}

/**
 * Normalizes path separators for comparison without resolving user input.
 *
 * @param value - Displayed or user-entered path.
 * @returns Forward-slash path used only for matching.
 */
function normalizeSearchPath(value: string): string {
  return value.replaceAll("\\", "/");
}

/**
 * Produces one compact path rooted at the user's home when possible.
 *
 * @param repositoryRoot - Canonical absolute repository root.
 * @returns Home-relative or absolute display path.
 */
function displayRepositoryPath(repositoryRoot: string): string {
  const relative = path.relative(os.homedir(), repositoryRoot);
  const insideHome =
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`));
  if (!insideHome) return repositoryRoot;
  if (!relative) return "~";
  return `~/${relative.split(path.sep).join("/")}`;
}

/**
 * Compares repositories deterministically by name and canonical root.
 *
 * @param left - First repository.
 * @param right - Second repository.
 * @returns Negative, zero, or positive sort result.
 */
function compareRepositories(
  left: DiscoveredRepository,
  right: DiscoveredRepository,
): number {
  return (
    left.name.localeCompare(right.name) || left.root.localeCompare(right.root)
  );
}

/**
 * Selects a cursor-aware window of repository matches for terminal rendering.
 *
 * @param repositories - Indexed filtered repository rows.
 * @param cursor - Active index in the complete editor row collection.
 * @returns At most the configured number of visible repository rows.
 */
function repositoryWindow(
  repositories: readonly IndexedEditorRow[],
  cursor: number,
): IndexedEditorRow[] {
  if (repositories.length <= MAX_VISIBLE_REPOSITORIES) {
    return [...repositories];
  }
  const activeOffset = repositories.findIndex(({ index }) => index === cursor);
  const centeredStart =
    activeOffset === -1
      ? 0
      : activeOffset - Math.floor(MAX_VISIBLE_REPOSITORIES / 2);
  const start = Math.max(
    0,
    Math.min(centeredStart, repositories.length - MAX_VISIBLE_REPOSITORIES),
  );
  return repositories.slice(start, start + MAX_VISIBLE_REPOSITORIES);
}

/**
 * Returns the number of selectable rows for the active menu screen.
 *
 * @param screen - Current manager screen.
 * @param workspaces - Current workspaces.
 * @param editorRows - Current editor rows.
 * @returns Positive row count.
 */
function managerRowCount(
  screen: ManagerScreen,
  workspaces: readonly ManagedWorkspace[],
  editorRows: readonly EditorRow[],
): number {
  if (screen.kind === "workspaces") return workspaces.length + 2;
  if (screen.kind === "actions") return 4;
  if (screen.kind === "delete") return 2;
  if (screen.kind === "edit") return editorRows.length;
  return 1;
}

/**
 * Returns the addressed workspace key when a screen carries one.
 *
 * @param screen - Current manager screen.
 * @returns Workspace key or `undefined`.
 */
function screenWorkspaceKey(screen: ManagerScreen): string | undefined {
  return "workspaceKey" in screen ? screen.workspaceKey : undefined;
}

/**
 * Converts one editor action discriminator to its visible label.
 *
 * @param kind - Editor row behavior.
 * @returns Human-readable action label.
 */
function editorActionLabel(kind: EditorRow["kind"]): string {
  if (kind === "save") return "Save workspace";
  if (kind === "back") return "Back";
  return "";
}

/**
 * Returns concise keyboard guidance for one manager screen.
 *
 * @param screen - Current manager screen.
 * @returns Footer text.
 */
function footerForScreen(screen: ManagerScreen): string {
  if (screen.kind === "name") {
    return "Enter confirm · Esc back · Ctrl-C cancel";
  }
  if (screen.kind === "edit") {
    return "Type to extend path · ↑/↓ move · Space select · Enter choose · Ctrl-C cancel";
  }
  return "↑/↓ move · Enter choose · Ctrl-C cancel";
}

/**
 * Toggles one canonical repository root without mutating React state.
 *
 * @param current - Current selected root set.
 * @param root - Canonical root to add or remove.
 * @returns New selected root set.
 */
function toggleSelection(
  current: ReadonlySet<string>,
  root: string,
): Set<string> {
  const next = new Set(current);
  if (next.has(root)) next.delete(root);
  else next.add(root);
  return next;
}

/**
 * Wraps one cursor index around a non-empty list.
 *
 * @param index - Proposed cursor index.
 * @param length - Candidate row count.
 * @returns Valid wrapped index.
 */
function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return (index + length) % length;
}

/**
 * Removes terminal control characters from one raw input chunk.
 *
 * @param value - Raw Ink input text.
 * @returns Printable terminal-safe text.
 */
function printableInput(value: string): string {
  return [...value]
    .filter((character) => character >= " " && character !== "\u007f")
    .join("");
}

/**
 * Removes one editable path character while keeping home as the empty state.
 *
 * @param value - Current complete finder path.
 * @returns Shortened path, never an empty string.
 */
function backspaceFinderPath(value: string): string {
  if (value === "~") return value;
  const characters = [...value];
  characters.pop();
  return characters.join("") || "~";
}

/**
 * Validates one workspace name before it reaches persistence.
 *
 * @param value - Trimmed workspace name.
 * @returns Whether the name is non-empty, printable, and bounded.
 */
function validWorkspaceName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 80 &&
    [...value].every((character) => character >= " " && character !== "\u007f")
  );
}

/**
 * Creates a collision-resistant key used only during one manager session.
 *
 * @returns Temporary React identity.
 */
function temporaryWorkspaceKey(): string {
  return `draft-${randomUUID()}`;
}
