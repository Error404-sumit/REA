import { isAbsolute, resolve, sep } from "node:path";

/**
 * Anchor an operator-relative path at the working directory without changing
 * which file the operating system selects.
 *
 * `path.resolve` collapses `..` lexically, so `link/../file` becomes
 * `<parent of link>/file` even though POSIX follows `link` first. Prefix the
 * working directory instead and leave every component for the kernel.
 */
export const anchorOperatorPath = (path: string): string => {
  if (path === "") return path;
  // Win32 resolves dot components before directory links, including drive-relative paths.
  if (sep === "\\") return resolve(path);
  if (isAbsolute(path)) return path;
  const base = process.cwd();
  return `${base}${base.endsWith(sep) ? "" : sep}${path}`;
};
