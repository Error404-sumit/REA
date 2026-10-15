import { createHash } from "node:crypto";
import { posix } from "node:path";

import { logicalPathEscapesRoot } from "../domain/artifactIdentity.js";
import {
  createReferenceSourcePathLookup,
  isPortableAbsoluteReferenceTarget,
  type ReferenceSourcePathLookup,
} from "../domain/referenceSourcePathIdentity.js";
import {
  classifyReferenceSourcePath,
  detectReferenceSourceLanguage,
} from "../domain/referenceSourceClassification.js";
import {
  NODE_MODULE_EXTENSIONS,
  nodeModuleFileCandidates,
  nodeModuleIndexCandidates,
} from "../domain/javascript/nodeModulePathCandidates.js";
import type { HistoricalSourceGraphInput } from "../domain/referenceSourceGraph.js";
import {
  parseReferenceSourceImports,
  PARSEABLE_REFERENCE_SOURCE_LANGUAGES,
} from "../domain/referenceSourceImportParsing.js";
import type {
  ReferenceSourceEntry,
  ReferenceSourceRead,
} from "../reference/ReferenceSourceReaderTypes.js";
import { typescriptEmittedSourceCandidates } from "./TypeScriptEmittedSourceCandidates.js";

export interface ParsedReferenceSourceEntries {
  readonly entries: HistoricalSourceGraphInput["entries"];
  readonly relationships: HistoricalSourceGraphInput["relationships"];
  readonly parseFailures: HistoricalSourceGraphInput["parse_failures"];
  readonly limitations: string[];
}

/** Preserve the observed reader failure and add entry-specific recovery guidance. */
export const projectReferenceSourceEntryFailure = (
  entry: Extract<ReferenceSourceEntry, { status: "failed" }>,
): string => `${entry.message} ${entryRecoveryGuidance(entry)}`;

const entryRecoveryGuidance = (
  entry: Extract<ReferenceSourceEntry, { status: "failed" }>,
): string => {
  if (entry.code === "cancelled")
    return "This entry was not read because the import was cancelled. Start the import again when ready.";
  if (entry.code === "unsupported")
    return "Exclude this entry or replace it with a regular file.";
  if (entry.kind === "directory")
    return "This directory could not be read. Check its permissions, then try again.";
  if (entry.kind === "symlink")
    return "This symbolic link could not be read safely. Check the link and its permissions, then try again.";
  if (entry.kind === "unknown")
    return "This entry's type could not be determined. Check the parent directory and try again.";
  return "This file could not be read. Check its permissions, then try again.";
};

const hashBytes = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const failedEntry = (
  entry: Extract<ReferenceSourceEntry, { status: "failed" }>,
): HistoricalSourceGraphInput["entries"][number] => {
  const classifications = classifyReferenceSourcePath(entry.path);
  const limitation = projectReferenceSourceEntryFailure(entry);
  if (entry.kind === "directory")
    return {
      path: entry.path,
      kind: "directory",
      classifications,
      tree_state: "unreadable",
      limitations: [limitation],
    };
  if (entry.kind === "symlink")
    return {
      path: entry.path,
      kind: "symlink",
      target: null,
      target_state: "unreadable",
      classifications,
      limitations: [limitation],
    };
  if (entry.kind === "unknown" || entry.kind === "other")
    return {
      path: entry.path,
      kind: "unknown",
      classifications: ["unknown"],
      limitations: [limitation],
    };
  return {
    path: entry.path,
    kind: "file",
    sha256: null,
    size: entry.size ?? null,
    language: null,
    classifications: entry.kind === "file" ? classifications : ["unknown"],
    content_state: "unreadable",
    limitations: [limitation],
  };
};

/** A package directory's legacy `main` entry point, as its manifest declares it. */
type PackageMain =
  | { readonly state: "declared"; readonly main: string }
  | { readonly state: "none" }
  | { readonly state: "unknown" };

/**
 * Read each inventoried `package.json` once. Node selects a non-empty string
 * `main` before a directory index; an unreadable or invalid manifest leaves
 * that selection unknown.
 */
const readPackageMains = (
  read: ReferenceSourceRead,
): ReadonlyMap<string, PackageMain> => {
  const mains = new Map<string, PackageMain>();
  for (const entry of read.entries) {
    if (posix.basename(entry.path) !== "package.json") continue;
    const directory = posix.dirname(entry.path);
    if (entry.status !== "read" || entry.kind !== "file") {
      mains.set(directory, { state: "unknown" });
      continue;
    }
    try {
      const manifest: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(entry.bytes),
      );
      const main =
        typeof manifest === "object" && manifest !== null
          ? Reflect.get(manifest, "main")
          : undefined;
      mains.set(
        directory,
        typeof main === "string" && main !== ""
          ? { state: "declared", main }
          : { state: "none" },
      );
    } catch {
      mains.set(directory, { state: "unknown" });
    }
  }
  return mains;
};

const SOURCE_RESOLUTION_SUFFIXES = [
  "",
  ".ts",
  ".js",
  ".mjs",
  ".cjs",
  ".tsx",
  ".jsx",
];

const TYPESCRIPT_SOURCE_RESOLUTION_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".d.ts",
  ".js",
  ".jsx",
];

const NODE_RUNTIME_FALLBACK_EXTENSIONS = NODE_MODULE_EXTENSIONS.filter(
  (extension) => extension !== ".js",
);

type InternalSpecifierResolutionMode =
  | "source"
  | "typescript-source"
  | "node-require";

const resolutionSuffixes = (
  mode: InternalSpecifierResolutionMode,
): readonly string[] =>
  mode === "typescript-source"
    ? TYPESCRIPT_SOURCE_RESOLUTION_SUFFIXES
    : SOURCE_RESOLUTION_SUFFIXES;

const fileCandidates = (
  candidate: string,
  mode: InternalSpecifierResolutionMode,
): readonly string[] =>
  mode === "node-require"
    ? nodeModuleFileCandidates(candidate)
    : resolutionSuffixes(mode).map((suffix) => `${candidate}${suffix}`);

const indexCandidates = (
  directory: string,
  mode: InternalSpecifierResolutionMode,
): readonly string[] =>
  mode === "node-require"
    ? nodeModuleIndexCandidates(directory)
    : resolutionSuffixes(mode)
        .filter((suffix) => suffix !== "")
        .map((suffix) => posix.join(directory, `index${suffix}`));

const nodeRuntimeFallbackFileCandidates = (candidate: string): string[] =>
  NODE_RUNTIME_FALLBACK_EXTENSIONS.map(
    (extension) => `${candidate}${extension}`,
  );

const nodeRuntimeFallbackIndexCandidates = (directory: string): string[] =>
  NODE_RUNTIME_FALLBACK_EXTENSIONS.map((extension) =>
    posix.join(directory, `index${extension}`),
  );

/** Inventory facts an internal specifier resolves against. */
interface SpecifierContext {
  readonly lookupPath: ReferenceSourcePathLookup;
  readonly packageMains: ReadonlyMap<string, PackageMain>;
}

/**
 * Apply a package `main` to an index match with the importing edge's resolution
 * strategy, then fall back to the package's index when no main target is found.
 */
const selectPackageMain = (
  index: string,
  context: SpecifierContext,
  resolutionMode: InternalSpecifierResolutionMode,
): { to: string; resolution: "internal" | "unresolved" } => {
  const directory = posix.dirname(index);
  const manifest = context.packageMains.get(directory);
  if (manifest === undefined || manifest.state === "none")
    return { to: index, resolution: "internal" };
  if (manifest.state === "unknown")
    return { to: directory, resolution: "unresolved" };
  // Node resolves `main` with path.resolve: an absolute main leaves the
  // package, and a trailing separator does not make the entry a directory.
  if (posix.isAbsolute(manifest.main))
    return { to: posix.normalize(manifest.main), resolution: "unresolved" };
  const target = posix
    .normalize(posix.join(directory, manifest.main))
    .replace(/(?<=.)\/+$/u, "");
  // Node would load a declared entry outside the imported root.
  if (logicalPathEscapesRoot(target))
    return { to: target, resolution: "unresolved" };
  const mainCandidates =
    resolutionMode === "node-require"
      ? [
          ...nodeModuleFileCandidates(target),
          ...nodeModuleIndexCandidates(target),
        ]
      : resolutionMode === "typescript-source"
        ? [
            ...fileCandidates(target, resolutionMode),
            ...nodeRuntimeFallbackFileCandidates(target),
            ...indexCandidates(target, resolutionMode),
            ...nodeRuntimeFallbackIndexCandidates(target),
          ]
        : [
            ...nodeModuleFileCandidates(target),
            ...fileCandidates(target, resolutionMode),
            ...nodeModuleIndexCandidates(target),
            ...indexCandidates(target, resolutionMode),
          ];
  const selected = context.lookupPath.resolveCandidates(mainCandidates);
  return { to: selected ?? index, resolution: "internal" };
};

const resolveInternalSpecifier = (
  fromPath: string,
  specifier: string,
  resolutionMode: InternalSpecifierResolutionMode,
  context: SpecifierContext,
): { to: string; resolution: "internal" | "unresolved" } => {
  if (posix.isAbsolute(specifier))
    return { to: specifier, resolution: "unresolved" };
  const normalized = posix.normalize(
    posix.join(posix.dirname(fromPath), specifier),
  );
  if (logicalPathEscapesRoot(normalized))
    return { to: normalized, resolution: "unresolved" };
  // Preserve directory intent before normalization removes terminal dot segments.
  const directoryReference =
    specifier.endsWith("/") || [".", ".."].includes(posix.basename(specifier));
  // A directory resolves only to an index with an extension; neither Node nor
  // TypeScript selects an extensionless `index` file. CommonJS `require` only
  // probes Node's runtime file extensions; source-only suffixes must not outrank
  // a directory index or make a sibling .cjs file an implicit require target.
  const candidates = [
    ...(directoryReference ? [] : fileCandidates(normalized, resolutionMode)),
    ...indexCandidates(normalized, resolutionMode),
  ];
  // Retain present runtime files first; substitute only a missing counterpart.
  // Counterparts cover explicit filenames, not directory/index resolution.
  if (!directoryReference)
    candidates.push(
      ...typescriptEmittedSourceCandidates(fromPath, normalized).map(
        ({ path }) => path,
      ),
    );
  const match = context.lookupPath.resolveCandidates(candidates);
  if (match === undefined) return { to: normalized, resolution: "unresolved" };
  const resolvedThroughIndex =
    posix.basename(match).startsWith("index.") &&
    posix.dirname(match).normalize("NFC") === normalized.normalize("NFC");
  return resolvedThroughIndex
    ? selectPackageMain(match, context, resolutionMode)
    : { to: match, resolution: "internal" };
};

type ReadFile = Extract<ReferenceSourceEntry, { status: "read"; kind: "file" }>;

const appendFile = (
  entry: ReadFile,
  context: SpecifierContext,
  output: ParsedReferenceSourceEntries,
): void => {
  const language = detectReferenceSourceLanguage(entry.path);
  const parsed =
    language === null || !PARSEABLE_REFERENCE_SOURCE_LANGUAGES.has(language)
      ? undefined
      : parseReferenceSourceImports(entry.path, entry.bytes, language);
  output.entries.push({
    path: entry.path,
    kind: "file",
    sha256: hashBytes(entry.bytes),
    size: entry.size,
    language,
    classifications: classifyReferenceSourcePath(entry.path),
    content_state: "hashed",
    limitations: [...(parsed?.limitations ?? [])],
  });
  if (parsed === undefined) return;
  for (const relationship of parsed.relationships) {
    const { resolutionStrategy, ...graphRelationship } = relationship;
    if (graphRelationship.resolution !== "internal") {
      output.relationships.push(graphRelationship);
      continue;
    }
    const resolutionMode =
      graphRelationship.kind !== "requires"
        ? "source"
        : resolutionStrategy === "typescript-source"
          ? "typescript-source"
          : "node-require";
    const resolved = resolveInternalSpecifier(
      graphRelationship.from_path,
      graphRelationship.to,
      resolutionMode,
      context,
    );
    output.relationships.push({
      ...graphRelationship,
      to: resolved.to,
      resolution: resolved.resolution,
    });
  }
  output.parseFailures.push(...parsed.parse_failures);
};

const appendReadEntry = (
  entry: Extract<ReferenceSourceEntry, { status: "read" }>,
  context: SpecifierContext,
  output: ParsedReferenceSourceEntries,
): void => {
  if (entry.kind === "file") {
    appendFile(entry, context, output);
    return;
  }
  const classifications = classifyReferenceSourcePath(entry.path);
  if (entry.kind === "directory") {
    output.entries.push({
      path: entry.path,
      kind: "directory",
      classifications,
      tree_state: "enumerated",
      limitations: [],
    });
    return;
  }
  output.entries.push({
    path: entry.path,
    kind: "symlink",
    // The reader resolves inventory identities from its root; the persisted
    // graph represents relative symlink targets from the link's directory.
    target:
      entry.targetState === "internal" ||
      (entry.targetState === "missing" &&
        !isPortableAbsoluteReferenceTarget(entry.target))
        ? posix.relative(posix.dirname(entry.path), entry.target) || "."
        : entry.target,
    target_state: entry.targetState,
    classifications,
    limitations: [],
  });
};

/** Convert bounded reader observations into graph entries and parsed edges. */
export const parseReferenceSourceEntries = (
  read: ReferenceSourceRead,
  filePaths: ReadonlySet<string>,
  signal?: AbortSignal,
): ParsedReferenceSourceEntries => {
  const output: ParsedReferenceSourceEntries = {
    entries: [],
    relationships: [],
    parseFailures: [],
    limitations: [...read.limitations],
  };
  const context: SpecifierContext = {
    lookupPath: createReferenceSourcePathLookup(filePaths),
    packageMains: readPackageMains(read),
  };
  for (const entry of read.entries) {
    if (signal?.aborted === true) break;
    if (entry.status === "failed") output.entries.push(failedEntry(entry));
    else appendReadEntry(entry, context, output);
  }
  return output;
};
