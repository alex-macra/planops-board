/** Stories and enablers group task rows without storing a second status. */
import type { DetailBlock, DetailField } from "./detail.ts";

/** Story IDs use one prefix segment followed by `S` and two digits. */
export const STORY_ID_RE = /^[A-Z][A-Z0-9]*-S\d{2}$/;

export type StoryKind = "story" | "enabler";

export interface Story {
  readonly id: string;
  readonly file: string;
  readonly epic: string;
  /** The heading's own text - a short name, not the sentence. */
  readonly title: string;
  readonly kind: StoryKind;
  /** Who the outcome is for. Null on an enabler, which has no end user. */
  readonly role: string | null;
  readonly outcome: string;
  readonly soThat: string;
  /** What you would do to see it working. The story's definition of shipped. */
  readonly demo: string | null;
  /** Rows that deliver it, in ledger order. */
  readonly taskIds: readonly string[];
  readonly headingLine: number;
}

/** Backticked IDs in a `Delivered by:` field. */
const MEMBER_ID_RE = /`([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)`/g;

export function isStoryId(id: string): boolean {
  return STORY_ID_RE.test(id);
}

function fieldValue(fields: readonly DetailField[], label: string): string | null {
  const field = fields.find((candidate) => candidate.label === label);
  if (!field) return null;
  const value = field.items.filter((item) => item.length > 0).join(" ").trim();
  return value.length > 0 ? value : null;
}

function parseKind(raw: string | null): StoryKind {
  return raw?.trim().toLowerCase() === "enabler" ? "enabler" : "story";
}

/**
 * One story from its block, or null if the block does not carry the two fields
 * the sentence cannot be written without.
 *
 * Everything softer is left to structural validation: the board's job
 * when a story is half-written is to show what is there, not to make the row
 * disappear from a view whose whole purpose is telling you what is unfinished.
 */
export function storyOf(block: DetailBlock, epic: string): Story | null {
  if (!isStoryId(block.id)) return null;

  const outcome = fieldValue(block.fields, "Outcome");
  const soThat = fieldValue(block.fields, "So that");
  if (!outcome || !soThat) return null;

  const kind = parseKind(fieldValue(block.fields, "Kind"));
  const delivered = fieldValue(block.fields, "Delivered by") ?? "";

  return {
    id: block.id,
    file: block.file,
    epic,
    title: block.title ?? block.id,
    kind,
    // An enabler's role is dropped rather than trusted: the sentence template
    // branches on `kind`, and a stray role would render "As a …" for work that
    // has no end user, which is the exact failure the two kinds exist to avoid.
    role: kind === "story" ? fieldValue(block.fields, "Role") : null,
    outcome,
    soThat,
    demo: fieldValue(block.fields, "Demo"),
    taskIds: [...new Set([...delivered.matchAll(MEMBER_ID_RE)].map((match) => match[1]!))],
    headingLine: block.headingLine,
  };
}
