/**
 * Ages, for the "last changed" column and the activity timeline.
 *
 * Short enough to sit in a table cell without widening it, and deliberately
 * coarse: the underlying dates are commit dates, so implying minute precision
 * would overstate what the history actually knows.
 */
const DAY = 24 * 60 * 60 * 1000;

export function daysSince(iso: string, now = Date.now()): number {
  return Math.floor((now - new Date(iso).getTime()) / DAY);
}

export function age(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "-";
  const days = daysSince(iso, now);
  if (days < 0) return "today";
  if (days === 0) return "today";
  if (days === 1) return "1d";
  if (days < 28) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 365)}y`;
}

/** The ISO date, for a title attribute where the exact day matters. */
export function isoDay(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "-";
}
