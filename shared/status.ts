export const STATUS_QUALIFIER_SEPARATORS = [
  " - ",
  " \u2014 ",
  " \u2013 ",
  "; ",
] as const;

export interface ParsedStatusValue {
  readonly base: string | null;
  readonly separator: string;
  readonly qualifier: string;
}

export function parseStatusValue(
  status: string,
  bases: readonly string[],
): ParsedStatusValue {
  const candidates = [...bases].sort((a, b) => b.length - a.length);
  for (const base of candidates) {
    if (status === base) return { base, separator: "", qualifier: "" };
    for (const separator of STATUS_QUALIFIER_SEPARATORS) {
      if (status.startsWith(base + separator)) {
        return {
          base,
          separator,
          qualifier: status.slice(base.length + separator.length),
        };
      }
    }
  }
  return { base: null, separator: "", qualifier: "" };
}
