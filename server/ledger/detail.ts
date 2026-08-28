/** Per-task prose from `### TASK-001 - Title` blocks. */
import { contentLines, headings, type Heading } from "./parse.ts";

/** Shared by parsing and structural validation to keep heading identity exact. */
const ID_HEADING_RE = /^`?([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)`?(?:\s|$)/;

/** Accept legacy Unicode separators while writing plain hyphens. */
const TITLE_SEPARATOR_RE = /^[\u2014\u2013-]\s*/;

const ATX_RE = /^\s{0,3}(#{1,6})\s/;

/** A labelled bullet at indent zero, with the colon inside the bold text. */
const BULLET_LABEL_RE = /^- \*\*([^*]+?):\*\*\s*(.*)$/;

/** The same labelled shape without the bullet. */
const INLINE_LABEL_RE = /^\*\*([^*]+?):\*\*\s*(.*)$/;

/** `**Acceptance criteria**` alone on a line, with the list below it. */
const STANDALONE_LABEL_RE = /^\*\*([^*]+?)\*\*\s*$/;

const BULLET_RE = /^(\s*)[-*]\s+(.*)$/;

/** A trailing ISO date inside a label. */
const LABEL_DATE_RE = /^(.*?)\s*\((\d{4}-\d{2}-\d{2})\)\s*$/;

/** Backticked IDs named in prose. */
const PROSE_ID_RE = /`([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)`/g;

const LINK_RE = /\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)/g;

/**
 * Common label aliases normalize equivalent fields without restricting each
 * document's own label vocabulary.
 */
const LABEL_ALIASES: Readonly<Record<string, string>> = {
  Acceptance: "Acceptance criteria",
};

export interface DetailField {
  /** Aliased label, e.g. "Acceptance criteria". */
  readonly label: string;
  /** The label exactly as written. */
  readonly rawLabel: string;
  /** Parsed out of the label when it carries one. */
  readonly date: string | null;
  readonly items: readonly string[];
}

export interface DetailLink {
  readonly label: string;
  readonly href: string;
}

export interface DetailBlock {
  readonly id: string;
  readonly title: string | null;
  readonly file: string;
  readonly headingLine: number;
  readonly headingLevel: number;
  /** Last non-blank line of the block, where a new note is inserted after. */
  readonly endLine: number;
  readonly fields: readonly DetailField[];
  /** Paragraphs and bullets that carry no label at all. */
  readonly prose: readonly string[];
  /** Other task IDs named in the prose. Real edges no column captures. */
  readonly references: readonly string[];
  readonly links: readonly DetailLink[];
}

function headingLevel(line: string): number {
  const atx = line.match(ATX_RE);
  if (atx) return atx[1]!.length;
  return 2;
}

function aliasLabel(rawLabel: string): { label: string; date: string | null } {
  const dated = rawLabel.match(LABEL_DATE_RE);
  const bare = (dated ? dated[1]! : rawLabel).trim();
  return { label: LABEL_ALIASES[bare] ?? bare, date: dated ? dated[2]! : null };
}

interface OpenField {
  readonly rawLabel: string;
  readonly items: string[];
}

/**
 * Supports labelled bullets, standalone bold labels with lists, and unlabelled prose.
 */
function parseBody(
  bodyLines: readonly { line: number; text: string; fenced: boolean }[],
): { fields: DetailField[]; prose: string[] } {
  const fields: DetailField[] = [];
  const prose: string[] = [];
  let open: OpenField | null = null;
  /** Whether the last thing seen was prose that a wrapped line should join. */
  let paragraphOpen = false;
  /** Whether the previous line was part of the code block being accumulated. */
  let inFence = false;

  function flush(): void {
    paragraphOpen = false;
    if (!open) return;
    const { label, date } = aliasLabel(open.rawLabel);
    fields.push({
      label,
      rawLabel: open.rawLabel,
      date,
      items: open.items.filter((item) => item.length > 0),
    });
    open = null;
  }

  function startItem(text: string): void {
    if (open) open.items.push(text);
    else prose.push(text);
    paragraphOpen = false;
  }

  /** Join a wrapped line onto whatever entry is currently being built. */
  function continueLast(text: string): void {
    const target = open ? open.items : prose;
    const last = target[target.length - 1];
    if (last === undefined || last.length === 0) target.push(text);
    else target[target.length - 1] = `${last} ${text}`;
  }

  for (const { text, fenced } of bodyLines) {
    if (fenced) {
      // A code block is one entry, kept verbatim: nothing inside it is a label,
      // and an ASCII diagram means nothing once its lines are reflowed.
      if (inFence) prose[prose.length - 1] = `${prose[prose.length - 1]}\n${text}`;
      else {
        flush();
        prose.push(text);
        inFence = true;
      }
      continue;
    }
    inFence = false;

    if (text.trim().length === 0) {
      // A blank line ends the current item but not the field: the standalone
      // shape puts one between `**Acceptance criteria**` and its list.
      if (open) open.items.push("");
      paragraphOpen = false;
      continue;
    }

    const bulletLabel = text.match(BULLET_LABEL_RE);
    if (bulletLabel) {
      flush();
      open = { rawLabel: bulletLabel[1]!.trim(), items: [bulletLabel[2]!.trim()] };
      continue;
    }

    const standalone = text.match(STANDALONE_LABEL_RE);
    if (standalone) {
      flush();
      open = { rawLabel: standalone[1]!.trim(), items: [] };
      continue;
    }

    const inlineLabel = text.match(INLINE_LABEL_RE);
    if (inlineLabel) {
      flush();
      open = { rawLabel: inlineLabel[1]!.trim(), items: [inlineLabel[2]!.trim()] };
      continue;
    }

    const bullet = text.match(BULLET_RE);
    if (bullet) {
      // Indented bold lead-ins like `  - **Registered content keys.** One
      // opaque…` are prose, not labels: the discriminator is indent 0 plus a
      // colon inside the bold, which BULLET_LABEL_RE already requires.
      startItem(bullet[2]!.trim());
      continue;
    }

    if (/^\s/.test(text)) {
      continueLast(text.trim());
      continue;
    }

    // Unindented text. These documents hard-wrap at 79 columns, so a paragraph
    // is many such lines; only a blank line or a label ends one.
    if (paragraphOpen) {
      continueLast(text.trim());
      continue;
    }
    flush();
    prose.push(text.trim());
    paragraphOpen = true;
  }

  flush();
  return { fields, prose: prose.filter((entry) => entry.trim().length > 0) };
}

function collect(regex: RegExp, text: string, group: number): string[] {
  return [...text.matchAll(regex)].map((match) => match[group]!);
}

/**
 * Every ID-anchored block in one document.
 *
 * Blocks and table rows are not a bijection in either direction. Both unmatched
 * blocks and rows are represented so callers can report them accurately.
 */
export function extractDetailBlocks(
  lines: readonly string[],
  file: string,
): DetailBlock[] {
  const all: Heading[] = headings(lines);
  const fenced = new Set(lines.map((_, index) => index + 1));
  for (const content of contentLines(lines)) fenced.delete(content.line);

  const blocks: DetailBlock[] = [];

  all.forEach((heading, index) => {
    const match = heading.text.match(ID_HEADING_RE);
    if (!match) return;

    const level = headingLevel(lines[heading.line - 1] ?? "");
    // The block runs to the next heading at the same level or higher; a deeper
    // heading would be part of this task's own prose.
    const next = all
      .slice(index + 1)
      .find((candidate) => headingLevel(lines[candidate.line - 1] ?? "") <= level);
    const lastLine = (next ? next.line - 1 : lines.length);

    const bodyLines = [];
    for (let line = heading.line + 1; line <= lastLine; line += 1) {
      bodyLines.push({ line, text: lines[line - 1] ?? "", fenced: fenced.has(line) });
    }

    let endLine = heading.line;
    for (const body of bodyLines) {
      if (body.text.trim().length > 0) endLine = body.line;
    }

    const title = heading.text
      .slice(match[0].length)
      .trim()
      .replace(TITLE_SEPARATOR_RE, "")
      .trim();
    const bodyText = bodyLines.map((body) => body.text).join("\n");
    const { fields, prose } = parseBody(bodyLines);
    const id = match[1]!;

    blocks.push({
      id,
      title: title || null,
      file,
      headingLine: heading.line,
      headingLevel: level,
      endLine,
      fields,
      prose,
      references: [
        ...new Set(collect(PROSE_ID_RE, bodyText, 1).filter((reference) => reference !== id)),
      ],
      links: [...bodyText.matchAll(LINK_RE)].map((link) => ({
        label: link[1]!,
        href: link[2]!,
      })),
    });
  });

  return blocks;
}

/** The heading level a document uses for task blocks, for creating a new one. */
export function conventionalHeadingLevel(blocks: readonly DetailBlock[]): number {
  const counts = new Map<number, number>();
  for (const block of blocks) {
    counts.set(block.headingLevel, (counts.get(block.headingLevel) ?? 0) + 1);
  }
  let level = 3;
  let best = 0;
  for (const [candidate, count] of counts) {
    if (count > best) {
      best = count;
      level = candidate;
    }
  }
  return level;
}

/** Notes are the field the board itself writes; everything else it only reads. */
export function notesOf(block: DetailBlock): readonly DetailField[] {
  return block.fields.filter((field) => field.label === "Note");
}
