import { createHash } from "node:crypto";

import * as ts from "typescript";

import { compareStrings } from "../core/order.js";
import type {
  CheckpointTransitions,
  ObsoleteFactTarget,
  SurfaceItem,
  SurfaceKind,
} from "../core/types.js";
import { assertValidCommitSha, git } from "../replay/git.js";

/**
 * Source file extensions the TypeScript-only v1 extractor parses. Declaration
 * files are excluded because they are generated build output, not authored
 * surface.
 */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

/**
 * Path segments whose presence excludes a file from surface extraction: the
 * generated wiki, installed dependencies, and build output.
 */
const EXCLUDED_SEGMENTS = new Set(["openwiki", "node_modules", "dist"]);

/**
 * The exported constant name treated as the library version rather than as an
 * ordinary symbol, so a version bump is scored as a `version` transition and not
 * a redundant symbol change.
 */
const VERSION_CONST_NAME = "VERSION";

/**
 * A parsed source declaration reduced to the fields the surface needs: what to
 * call it, what kind it is, and its reconstructed one-line signature.
 */
interface DeclaredSymbol {
  /**
   * The exported symbol name.
   */
  name: string;

  /**
   * The declaration kind, used to word the surface statement.
   */
  declKind:
    | "function"
    | "class"
    | "interface"
    | "type"
    | "enum"
    | "constant"
    | "export";

  /**
   * The reconstructed one-line signature, or the bare name for a re-export whose
   * declaration lives outside the parsed tree.
   *
   * @default undefined when only a re-export named the symbol, so a later
   *   declaration of the same name can supply the real signature
   */
  signature?: string;

  /**
   * Repository-relative path of the file the symbol was found in.
   */
  filePath: string;
}

/**
 * Derive a short, stable content hash of a surface statement, used as the
 * version-suffix of a `factVersionId`. Deterministic (no clock, no randomness),
 * so an unchanged statement keeps its id across checkpoints and any change mints
 * a fresh one.
 *
 * @param statement - The surface statement to hash.
 *
 * @returns The first eight hex characters of the statement's SHA-1 digest.
 */
function shortHash(statement: string): string {
  return createHash("sha1").update(statement).digest("hex").slice(0, 8);
}

/**
 * Assemble a `SurfaceItem`, deriving its content-addressed `factVersionId` from
 * the statement so identity tracks meaning.
 *
 * @param factId - The stable logical id, for example `symbol:add`.
 * @param kind - The surface element's kind.
 * @param name - The human-readable name.
 * @param statement - The self-contained descriptive claim.
 * @param signature - The reconstructed signature for a symbol, if any.
 *
 * @returns The assembled surface item.
 */
function makeItem(
  factId: string,
  kind: SurfaceKind,
  name: string,
  statement: string,
  signature?: string,
): SurfaceItem {
  return {
    factId,
    factVersionId: `${factId}@${shortHash(statement)}`,
    kind,
    name,
    ...(signature === undefined ? {} : { signature }),
    statement,
  };
}

/**
 * Whether a declaration carries the `export` keyword modifier.
 *
 * @param node - The node to inspect.
 *
 * @returns True when the node is exported.
 */
function isExported(node: ts.Node): boolean {
  return (
    (ts.getCombinedModifierFlags(node as ts.Declaration) &
      ts.ModifierFlags.Export) !==
    0
  );
}

/**
 * Render a declaration's type parameter list, for example `<T = unknown>`, or an
 * empty string when it has none.
 *
 * @param node - The declaration whose type parameters to render.
 * @param sourceFile - The source file the node belongs to, for text extraction.
 *
 * @returns The bracketed type parameter list, or an empty string.
 */
function typeParameterText(
  node:
    | ts.InterfaceDeclaration
    | ts.TypeAliasDeclaration
    | ts.ClassDeclaration
    | ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
): string {
  if (node.typeParameters === undefined || node.typeParameters.length === 0) {
    return "";
  }

  const parameters = node.typeParameters
    .map((parameter) => parameter.getText(sourceFile))
    .join(", ");
  return `<${parameters}>`;
}

/**
 * Collapse a snippet of source text to a single normalized line so a signature
 * is stable regardless of the formatting the author used.
 *
 * @param text - The raw source text.
 *
 * @returns The text with runs of whitespace collapsed to single spaces.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * Reduce one exported top-level statement to the symbols it declares, dropping
 * the version constant (surfaced separately) and anything not exported. A single
 * variable statement may declare several symbols.
 *
 * @param node - The top-level statement to inspect.
 * @param sourceFile - The source file the node belongs to.
 * @param filePath - Repository-relative path of the file.
 *
 * @returns The declared symbols, in source order.
 */
function symbolsFromStatement(
  node: ts.Statement,
  sourceFile: ts.SourceFile,
  filePath: string,
): DeclaredSymbol[] {
  if (ts.isFunctionDeclaration(node) && isExported(node) && node.name) {
    const parameters = node.parameters
      .map((parameter) => oneLine(parameter.getText(sourceFile)))
      .join(", ");
    const returnType =
      node.type === undefined
        ? ""
        : `: ${oneLine(node.type.getText(sourceFile))}`;
    const signature = `${node.name.text}${typeParameterText(node, sourceFile)}(${parameters})${returnType}`;
    return [
      { name: node.name.text, declKind: "function", signature, filePath },
    ];
  }

  if (ts.isClassDeclaration(node) && isExported(node) && node.name) {
    return [
      {
        name: node.name.text,
        declKind: "class",
        signature: `class ${node.name.text}${typeParameterText(node, sourceFile)}`,
        filePath,
      },
    ];
  }

  if (ts.isInterfaceDeclaration(node) && isExported(node)) {
    return [
      {
        name: node.name.text,
        declKind: "interface",
        signature: `interface ${node.name.text}${typeParameterText(node, sourceFile)}`,
        filePath,
      },
    ];
  }

  if (ts.isTypeAliasDeclaration(node) && isExported(node)) {
    return [
      {
        name: node.name.text,
        declKind: "type",
        signature: `type ${node.name.text}${typeParameterText(node, sourceFile)} = ${oneLine(node.type.getText(sourceFile))}`,
        filePath,
      },
    ];
  }

  if (ts.isEnumDeclaration(node) && isExported(node)) {
    return [
      {
        name: node.name.text,
        declKind: "enum",
        signature: `enum ${node.name.text}`,
        filePath,
      },
    ];
  }

  if (ts.isVariableStatement(node) && isExported(node)) {
    const symbols: DeclaredSymbol[] = [];
    for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) {
        continue;
      }
      const name = declaration.name.text;
      if (name === VERSION_CONST_NAME) {
        continue;
      }
      const typeText =
        declaration.type === undefined
          ? ""
          : `: ${oneLine(declaration.type.getText(sourceFile))}`;
      symbols.push({
        name,
        declKind: "constant",
        signature: `const ${name}${typeText}`,
        filePath,
      });
    }
    return symbols;
  }

  if (ts.isExportDeclaration(node) && node.exportClause !== undefined) {
    if (ts.isNamedExports(node.exportClause)) {
      return node.exportClause.elements.map((element) => ({
        name: element.name.text,
        declKind: "export" as const,
        filePath,
      }));
    }
  }

  return [];
}

/**
 * Read the version constant declared in one source file, if present. A version
 * bump is the canonical evolution signal, so it is extracted directly rather
 * than treated as an ordinary symbol.
 *
 * @param sourceFile - The parsed source file to scan.
 *
 * @returns The version string, or undefined when the file declares none.
 */
function versionFromSourceFile(sourceFile: ts.SourceFile): string | undefined {
  for (const node of sourceFile.statements) {
    if (!ts.isVariableStatement(node) || !isExported(node)) {
      continue;
    }
    for (const declaration of node.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === VERSION_CONST_NAME &&
        declaration.initializer !== undefined &&
        ts.isStringLiteral(declaration.initializer)
      ) {
        return declaration.initializer.text;
      }
    }
  }

  return undefined;
}

/**
 * Whether a repository-relative path is a parseable source file: a TypeScript
 * source extension, not a declaration or test file, and outside every excluded
 * directory.
 *
 * @param relativePath - The repository-relative path to test.
 *
 * @returns True when the file contributes to the surface.
 */
function isSourceFile(relativePath: string): boolean {
  const segments = relativePath.split("/");
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) {
    return false;
  }
  if (/\.(test|spec)\.[cm]?tsx?$/u.test(relativePath)) {
    return false;
  }
  if (relativePath.endsWith(".d.ts")) {
    return false;
  }

  return SOURCE_EXTENSIONS.some((extension) =>
    relativePath.endsWith(extension),
  );
}

/**
 * Read one blob's UTF-8 content at a commit via `git show`.
 *
 * @param repoPath - Absolute path to the source Git repository.
 * @param commit - The already-validated commit SHA to read at.
 * @param relativePath - Repository-relative path of the blob.
 *
 * @returns The blob's content.
 */
async function readBlob(
  repoPath: string,
  commit: string,
  relativePath: string,
): Promise<string> {
  return git(repoPath, ["show", `${commit}:${relativePath}`]);
}

/**
 * The `version` surface item for a checkpoint: an exported `VERSION` constant if
 * one exists, otherwise the `package.json` version field. Returns undefined when
 * the repository declares neither.
 *
 * @param repoPath - Absolute path to the source Git repository.
 * @param commit - The already-validated commit SHA.
 * @param sourceFiles - Parsed source files, scanned for a `VERSION` constant.
 * @param trackedPaths - Every tracked path at the commit, to locate a manifest.
 *
 * @returns The version surface item, or undefined.
 */
async function extractVersion(
  repoPath: string,
  commit: string,
  sourceFiles: ts.SourceFile[],
  trackedPaths: string[],
): Promise<SurfaceItem | undefined> {
  let version: string | undefined;

  for (const sourceFile of sourceFiles) {
    version = versionFromSourceFile(sourceFile);
    if (version !== undefined) {
      break;
    }
  }

  if (version === undefined && trackedPaths.includes("package.json")) {
    try {
      const manifest = JSON.parse(
        await readBlob(repoPath, commit, "package.json"),
      ) as { version?: unknown };
      if (typeof manifest.version === "string" && manifest.version.length > 0) {
        version = manifest.version;
      }
    } catch {
      version = undefined;
    }
  }

  if (version === undefined) {
    return undefined;
  }

  return makeItem(
    "version",
    "version",
    version,
    `The library's current released version is "${version}".`,
  );
}

/**
 * Word a symbol's surface statement from its declaration kind and signature.
 *
 * @param symbol - The declared symbol to describe.
 *
 * @returns A self-contained claim naming the symbol, its kind, and its file.
 */
function symbolStatement(symbol: DeclaredSymbol): string {
  const article =
    symbol.declKind === "interface" || symbol.declKind === "enum" ? "an" : "a";
  if (symbol.signature === undefined) {
    return `The module \`${symbol.filePath}\` exports \`${symbol.name}\`.`;
  }
  if (symbol.declKind === "export") {
    return `The module \`${symbol.filePath}\` exports \`${symbol.signature}\`.`;
  }

  return `The module \`${symbol.filePath}\` exports ${article} ${symbol.declKind} \`${symbol.signature}\`.`;
}

/**
 * Extract a repository's public surface at a single commit: every exported
 * symbol, every parsed source file, and the version. Deterministic and derived
 * entirely from source at `commit`, never from the wiki, so it is the ground
 * truth the surface diff is computed against.
 *
 * TypeScript-only for v1: files outside {@link SOURCE_EXTENSIONS} do not
 * contribute surface items.
 *
 * @param repoPath - Absolute path to the source Git repository.
 * @param commit - Commit SHA to read the surface at. Validated before use.
 *
 * @returns The surface items, sorted by `factId`.
 */
export async function extractSurface(
  repoPath: string,
  commit: string,
): Promise<SurfaceItem[]> {
  assertValidCommitSha(commit);

  const listing = await git(repoPath, [
    "ls-tree",
    "-r",
    "-z",
    "--name-only",
    commit,
  ]);
  const trackedPaths = listing
    .split("\0")
    .filter((relativePath) => relativePath.length > 0)
    .sort(compareStrings);
  const sourcePaths = trackedPaths.filter(isSourceFile);

  const items: SurfaceItem[] = [];
  const sourceFiles: ts.SourceFile[] = [];
  // Dedupe symbols by name across files, preferring a real declaration over a
  // bare re-export so `export { Queue } from "./queue.js"` inherits the class's
  // reconstructed signature.
  const symbolByName = new Map<string, DeclaredSymbol>();

  for (const relativePath of sourcePaths) {
    const content = await readBlob(repoPath, commit, relativePath);
    const sourceFile = ts.createSourceFile(
      relativePath,
      content,
      ts.ScriptTarget.Latest,
      true,
    );
    sourceFiles.push(sourceFile);

    items.push(
      makeItem(
        `file:${relativePath}`,
        "file",
        relativePath,
        `The repository includes the source file \`${relativePath}\`.`,
      ),
    );

    for (const node of sourceFile.statements) {
      for (const symbol of symbolsFromStatement(
        node,
        sourceFile,
        relativePath,
      )) {
        const existing = symbolByName.get(symbol.name);
        if (existing === undefined) {
          symbolByName.set(symbol.name, symbol);
        } else if (
          existing.signature === undefined &&
          symbol.signature !== undefined
        ) {
          symbolByName.set(symbol.name, symbol);
        }
      }
    }
  }

  for (const symbol of symbolByName.values()) {
    items.push(
      makeItem(
        `symbol:${symbol.name}`,
        "symbol",
        symbol.name,
        symbolStatement(symbol),
        symbol.signature,
      ),
    );
  }

  const version = await extractVersion(
    repoPath,
    commit,
    sourceFiles,
    trackedPaths,
  );
  if (version !== undefined) {
    items.push(version);
  }

  return items.sort((a, b) => compareStrings(a.factId, b.factId));
}

/**
 * Classify every surface element's change from the previous checkpoint to the
 * current one into the four transition buckets, comparing by `factId` and
 * treating a changed `statement` as a new version. Elements absent at both
 * checkpoints do not appear. Derived only from the two surfaces, never from the
 * wiki, so it is fully deterministic.
 *
 * @param previous - The surface at the previous checkpoint.
 * @param current - The surface at the current checkpoint.
 * @param previousCheckpointId - The earlier checkpoint id.
 * @param currentCheckpointId - The later checkpoint id.
 *
 * @returns The structured transitions across this boundary.
 */
export function diffSurface(
  previous: SurfaceItem[],
  current: SurfaceItem[],
  previousCheckpointId: string,
  currentCheckpointId: string,
): CheckpointTransitions {
  const previousById = new Map(previous.map((item) => [item.factId, item]));
  const currentById = new Map(current.map((item) => [item.factId, item]));
  const factIds = [
    ...new Set([...previousById.keys(), ...currentById.keys()]),
  ].sort(compareStrings);

  const introduced: CheckpointTransitions["introduced"] = [];
  const changed: CheckpointTransitions["changed"] = [];
  const removed: CheckpointTransitions["removed"] = [];
  const stable: CheckpointTransitions["stable"] = [];

  for (const factId of factIds) {
    const before = previousById.get(factId);
    const after = currentById.get(factId);

    if (before === undefined && after !== undefined) {
      introduced.push({
        factId,
        factVersionId: after.factVersionId,
        statement: after.statement,
      });
      continue;
    }

    if (before !== undefined && after === undefined) {
      removed.push({
        factId,
        previousVersionId: before.factVersionId,
        previousStatement: before.statement,
      });
      continue;
    }

    if (before !== undefined && after !== undefined) {
      if (before.statement === after.statement) {
        stable.push({
          factId,
          factVersionId: after.factVersionId,
          statement: after.statement,
        });
      } else {
        changed.push({
          factId,
          previousVersionId: before.factVersionId,
          previousStatement: before.statement,
          currentVersionId: after.factVersionId,
          currentStatement: after.statement,
        });
      }
    }
  }

  return {
    checkpointId: currentCheckpointId,
    previousCheckpointId,
    introduced,
    changed,
    removed,
    stable,
  };
}

/**
 * The forgetting targets for a boundary: the obsolete previous version of every
 * changed element and of every removed element. A stable element has no obsolete
 * version and an introduced element has no previous version, so neither
 * contributes. This is the only source of forgetting targets, so no obsolete
 * version is double-counted across passes.
 *
 * @param transitions - The structured transitions for the boundary.
 *
 * @returns One target per obsolete version, changed elements before removed.
 */
export function obsoleteTargetsFor(
  transitions: CheckpointTransitions,
): ObsoleteFactTarget[] {
  const targets: ObsoleteFactTarget[] = [];

  for (const item of transitions.changed) {
    targets.push({
      factId: item.factId,
      factVersionId: item.previousVersionId,
      obsoleteStatement: item.previousStatement,
    });
  }

  for (const item of transitions.removed) {
    targets.push({
      factId: item.factId,
      factVersionId: item.previousVersionId,
      obsoleteStatement: item.previousStatement,
    });
  }

  return targets;
}

/**
 * Deduplicate obsolete forgetting targets by `factVersionId`, keeping the first
 * occurrence in trace order. A version goes obsolete at exactly one boundary, so
 * a duplicate can only arise from the sticky carry-forward concatenating a target
 * with itself; this is a defensive guard that keeps the evaluator from ever
 * seeing one version twice within a single checkpoint.
 *
 * @param targets - The obsolete targets to deduplicate.
 *
 * @returns The targets with duplicate versions removed, in first-seen order.
 */
function dedupeTargets(targets: ObsoleteFactTarget[]): ObsoleteFactTarget[] {
  const seen = new Set<string>();

  return targets.filter((target) => {
    if (seen.has(target.factVersionId)) {
      return false;
    }

    seen.add(target.factVersionId);
    return true;
  });
}

/**
 * Advance the forgetting watch set across one checkpoint boundary. Once a
 * surface element goes obsolete it stays under watch at every later checkpoint
 * so the forgetting pass keeps re-checking it, which is what makes the
 * stale-knowledge lifetime diagnostic measurable; LEDGER does not treat
 * forgetting as permanent. A target leaves the set only when the surface revives
 * that exact knowledge (its `factId` is present again with the version's own
 * statement), so the wiki is never asked to forget something true again.
 *
 * @param inputs - The outstanding watch set, the current surface, and the
 *   versions this boundary newly retires.
 *
 * @returns The deduplicated watch set for the current checkpoint, with carried
 *   targets before this boundary's newly obsolete ones.
 */
export function advanceObsoleteWatchSet(inputs: {
  /**
   * Obsolete versions carried in from earlier boundaries.
   */
  outstanding: ObsoleteFactTarget[];

  /**
   * The surface at the current checkpoint, used to retire revived targets.
   */
  surface: SurfaceItem[];

  /**
   * Versions this boundary newly retires.
   */
  newlyObsolete: ObsoleteFactTarget[];
}): ObsoleteFactTarget[] {
  const statementByFactId = new Map(
    inputs.surface.map((item): [string, string] => [
      item.factId,
      item.statement,
    ]),
  );
  const carried = inputs.outstanding.filter(
    (target) =>
      statementByFactId.get(target.factId) !== target.obsoleteStatement,
  );

  return dedupeTargets([...carried, ...inputs.newlyObsolete]);
}
