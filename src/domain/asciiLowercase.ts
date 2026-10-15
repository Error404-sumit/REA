/** Lowercase only ASCII A-Z; Unicode case mapping is not applied. */
export const asciiLowercase = (value: string): string =>
  value.replace(/[A-Z]+/gu, (run) => run.toLowerCase());
