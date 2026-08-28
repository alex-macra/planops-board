/** The board uses one distinct phrase so it never rewrites a person's date note. */
const VERB = "Status set";

/** Matches only the board's own stamp, anchored at the end of the cell. */
const STAMP_RE = /\s*\*\*Status set \d{4}-\d{2}-\d{2}\.\*\*\s*$/;

export function today(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The outcome text with any previous board stamp removed. */
export function withoutStamp(outcome: string): string {
  return outcome.replace(STAMP_RE, "").trimEnd();
}

/**
 * Replace, never append: one stamp per row, always last, so a cell edited fifty
 * times is no longer than a cell edited once.
 */
export function stamped(outcome: string, date = today()): string {
  const body = withoutStamp(outcome);
  const stamp = `**${VERB} ${date}.**`;
  return body ? `${body} ${stamp}` : stamp;
}

export function stampDateOf(outcome: string): string | null {
  return /\*\*Status set (\d{4}-\d{2}-\d{2})\.\*\*\s*$/.exec(outcome)?.[1] ?? null;
}
