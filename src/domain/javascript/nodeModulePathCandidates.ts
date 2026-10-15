import { posix } from "node:path";

/** Node's CommonJS file and directory-index fallback extensions, in loader order. */
export const NODE_MODULE_EXTENSIONS = [".js", ".json", ".node"] as const;

/** Node's extension probes for a package `main`, including its directory-index fallback. */
export const NODE_PACKAGE_MAIN_SUFFIXES = [
  "",
  ...NODE_MODULE_EXTENSIONS,
  ...NODE_MODULE_EXTENSIONS.map((extension) => `/index${extension}`),
] as const;

/** Exact file first, then only the extensions Node probes for CommonJS `require`. */
export const nodeModuleFileCandidates = (
  candidate: string,
): readonly string[] => [
  candidate,
  ...NODE_MODULE_EXTENSIONS.map((extension) => `${candidate}${extension}`),
];

/** Directory-index fallbacks in Node's CommonJS loader order. */
export const nodeModuleIndexCandidates = (
  directory: string,
): readonly string[] =>
  NODE_MODULE_EXTENSIONS.map((extension) =>
    posix.join(directory, `index${extension}`),
  );
