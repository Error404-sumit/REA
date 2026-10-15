import { isMap, isNode, isScalar, isSeq, parseDocument, Document } from "yaml";

/**
 * ggcode reads MCP servers from ~/.ggcode/mcp_servers.yaml, a top-level YAML
 * sequence of named entries: `- name: rea` with `type`, `command`, `args`,
 * `env`, `url`, and `headers` members. An empty `type` connects as stdio.
 *
 * ggcode auto-migrates a legacy `mcp_servers` section of the main ggcode.yaml
 * into that standalone file, and honors the section only while the file is
 * absent. This module accepts both layouts so setup can read the legacy layer
 * and seed a fresh standalone file with its entries instead of suppressing
 * them. REA only ever writes the standalone file.
 */

// A comment-only document has no root; a bare marker has an unwritten null
// scalar. Explicit null values, tags and anchors remain actual values.
const isEmptyYamlRoot = (root: Document["contents"]): boolean =>
  root === null ||
  (isScalar(root) &&
    root.value === null &&
    root.source === "" &&
    root.tag === undefined &&
    root.anchor === undefined);

const parseGgcodeDocument = (text: string): Document => {
  const document = parseDocument(text);
  const error = document.errors[0];
  if (error !== undefined) throw error;
  return document;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Named entries of one mcp_servers sequence; malformed items fail closed. */
const sequenceEntries = (
  items: readonly unknown[],
  description: string,
): Record<string, unknown> => {
  const entries: Record<string, unknown> = {};
  for (const item of items) {
    if (!isPlainObject(item))
      throw new TypeError(`${description} entries must be named mappings`);
    const { name, ...entry } = item;
    // ggcode loads an unnamed entry, but no registration can address it by
    // name, so it stays written yet outside REA's server table.
    if (typeof name !== "string" || name === "") continue;
    entries[name] = entry;
  }
  return entries;
};

/** Legacy mapping form `mcp_servers: {name: entry}`; the key names the entry. */
const mappingEntries = (
  value: Record<string, unknown>,
  description: string,
): Record<string, unknown> => {
  const entries: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!isPlainObject(entry))
      throw new TypeError(`${description} entries must be mappings`);
    const { name: innerName, ...rest } = entry;
    void innerName;
    entries[name] = rest;
  }
  return entries;
};

const serverEntries = (
  value: unknown,
  description: string,
): Record<string, unknown> => {
  if (Array.isArray(value)) return sequenceEntries(value, description);
  if (isPlainObject(value)) return mappingEntries(value, description);
  throw new TypeError(
    `${description} must be a sequence of named server mappings`,
  );
};

/** Parse either ggcode layout into the synthetic `mcp_servers` server table. */
export const parseGgcodeConfigurationYaml = (
  text: string,
): Record<string, unknown> => {
  const document = parseGgcodeDocument(text);
  if (isEmptyYamlRoot(document.contents)) return {};
  const value: unknown = document.toJS();
  if (Array.isArray(value))
    return { mcp_servers: sequenceEntries(value, "The configuration root") };
  if (isPlainObject(value)) {
    const section = value.mcp_servers;
    return section === undefined
      ? {}
      : { mcp_servers: serverEntries(section, '"mcp_servers"') };
  }
  throw new TypeError(
    "The configuration root must be a sequence of named server mappings or a mapping holding mcp_servers",
  );
};

/**
 * Set or delete one named entry in a standalone mcp_servers.yaml, keeping the
 * rest of the document as written. A mapping root, which ggcode cannot load
 * as its standalone file, is rejected instead of being rewritten.
 */
export const editGgcodeConfigurationYaml = (
  text: string,
  serverKey: string,
  entry: unknown,
): string => {
  const document = parseGgcodeDocument(text);
  let root = document.contents;
  if (isEmptyYamlRoot(root)) {
    const sequence = document.createNode([]);
    if (isScalar(root))
      sequence.commentBefore = [root.commentBefore, root.comment]
        .filter((comment) => comment !== undefined)
        .join("\n");
    document.contents = sequence;
    root = sequence;
  }
  if (!isSeq(root))
    throw new TypeError(
      "The configuration root must be a sequence of named server mappings",
    );
  const index = root.items.findIndex(
    (item) => isMap(item) && item.get("name") === serverKey,
  );
  if (entry === undefined) {
    if (index >= 0) root.items.splice(index, 1);
  } else {
    const node = document.createNode({
      name: serverKey,
      ...(isPlainObject(entry) ? entry : {}),
    });
    if (index < 0) {
      root.items.push(node);
    } else {
      const previous = root.items[index];
      if (isNode(previous)) {
        const commentBefore = previous.commentBefore ?? node.commentBefore;
        if (commentBefore !== undefined) node.commentBefore = commentBefore;
        const comment = previous.comment ?? node.comment;
        if (comment !== undefined) node.comment = comment;
      }
      root.items[index] = node;
    }
  }
  // Editing REA must not reflow unrelated user entries or other YAML scalars.
  return document.toString({ lineWidth: 0 });
};

/** Create a standalone mcp_servers.yaml from the synthetic server table. */
export const stringifyGgcodeConfigurationYaml = (
  document: Record<string, unknown>,
): string => {
  const servers = document.mcp_servers;
  const entries = isPlainObject(servers)
    ? Object.entries(servers).map(([name, entry]) => ({
        name,
        ...(isPlainObject(entry) ? entry : {}),
      }))
    : [];
  return new Document(entries).toString({ lineWidth: 0 });
};
