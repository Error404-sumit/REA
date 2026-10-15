/** Bound the single central-directory allocation performed by the ZIP parser. */
export const ZIP_METADATA_READ_MAX_BYTES = 8 * 1024 * 1024;

/** Bound parsed entries and retained reader identities per ZIP traversal. */
export const ZIP_MAX_ENTRIES_PER_TRAVERSAL = 4_096;

/** Allow larger selected engine archives while keeping their traversal bounded. */
export const ZIP_MAX_ENTRIES_PER_ENGINE_ARCHIVE = 32_768;

export type ZipArtifactEntryLimit =
  | typeof ZIP_MAX_ENTRIES_PER_TRAVERSAL
  | typeof ZIP_MAX_ENTRIES_PER_ENGINE_ARCHIVE;
