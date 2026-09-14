/** Per-task prose from `### TASK-001 - Title` blocks. */
import { contentLines, headings, pythonStrip, type Heading } from "./parse.ts";

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

const TASK_PACKET_REQUIRED_LABELS = [
  "Readiness", "Objective", "Why", "Scope", "Starting point", "Decisions already made",
  "Decision authority", "Contract", "Change required", "Invariants", "Non-goals",
  "Acceptance criteria", "Verify", "Escalate, do not assume, if", "Handoff",
] as const;
const QWEN3_CODER_NEXT_PACKET_MARKER_RE =
  /^#{1,6}\s+(?:Qwen3-Coder-Next(?:\s+(?:readiness|task))?\s+packet(?:\s+-\s+\S.*)?|Qwen3\.8-Flash-Next packet)$/;
const ANY_QWEN_PACKET_MARKER_RE =
  /^#{1,6}\s+Qwen(?:3-Coder-Next|3\.8-Flash-Next)?(?:\s+(?:readiness|task))?\s+packet(?:\s+-\s+\S.*)?$/i;
const ANY_QWEN_PACKET_FIELD_MARKER_RE = /^Qwen(?:3-Coder-Next|3\.8-Flash-Next)?(?:\s+(?:readiness|task))?\s+packet$/i;

interface TaskPacketFieldRange {
  readonly start: number;
  readonly end: number;
}

function taskPacketFieldRanges(fields: readonly DetailField[]): TaskPacketFieldRange[] {
  if (fields.length > 2_000) return [];
  const ranges: TaskPacketFieldRange[] = [];
  for (let start = 0; start < fields.length; start += 1) {
    if (fields[start]?.label !== "Readiness") continue;
    const offset = fields.slice(start).findIndex((field) => field.label === "Handoff");
    if (offset === -1) continue;
    const end = start + offset;
    const labels = fields.slice(start, end + 1)
      .filter((field) => TASK_PACKET_REQUIRED_LABELS.some((label) => label === field.label))
      .map((field) => field.label);
    if (labels.length === TASK_PACKET_REQUIRED_LABELS.length &&
      TASK_PACKET_REQUIRED_LABELS.every((label, index) => labels[index] === label)) {
      ranges.push({ start, end });
    }
  }
  return ranges;
}

export function taskPacketFieldRange(fields: readonly DetailField[]): TaskPacketFieldRange | null {
  return taskPacketFieldRanges(fields)[0] ?? null;
}

export function qwen3CoderNextPacketIsReady(block: DetailBlock): boolean {
  if (block.prose.length > 2_000 || block.fields.length > 2_000) return false;
  const genericMarkers = block.prose.filter((item) => ANY_QWEN_PACKET_MARKER_RE.test(item) &&
    !QWEN3_CODER_NEXT_PACKET_MARKER_RE.test(item)).length +
    block.fields.filter((field) => ANY_QWEN_PACKET_FIELD_MARKER_RE.test(field.rawLabel) &&
      !QWEN3_CODER_NEXT_PACKET_MARKER_RE.test(`# ${field.rawLabel}`)).length;
  if (genericMarkers > 0) return false;
  const markerCount = block.prose.filter((item) => QWEN3_CODER_NEXT_PACKET_MARKER_RE.test(item)).length +
    block.fields.filter((field) => QWEN3_CODER_NEXT_PACKET_MARKER_RE.test(`# ${field.rawLabel}`)).length;
  if (markerCount !== 1) return false;
  const ranges = taskPacketFieldRanges(block.fields);
  if (ranges.length !== 1) return false;
  const range = ranges[0]!;
  const fields = block.fields.slice(range.start, range.end + 1);
  const statuses = fields.flatMap((field) => field.items).filter((item) => /^Packet status:/i.test(item));
  return statuses.length === 1 && statuses[0] === "Packet status: READY" &&
    fields[0]!.items.includes(statuses[0]);
}

const FENCE_RE = /^ {0,3}(?<marker>`{3,}|~{3,})(?<rest>.*)$/;
const SETEXT_HEADING_RE = /^ {0,3}(?:=+|-+)\s*$/;
const PARAGRAPH_INTERRUPT_RE = /^ {0,3}(?:#{1,6}(?:[ \t]+|$)|>|(?:[*+-]|\d{1,9}[.)])(?:[ \t]+|$))/;
const THEMATIC_BREAK_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/;
const TABLE_DELIMITER_ROW_RE = /^ {0,3}\|?[ \t]*:?-{3,}:?(?:[ \t]*\|[ \t]*:?-{3,}:?)+[ \t]*\|?[ \t]*$/;
const HTML_BLOCK_TAGS = new Set([
  "address", "article", "aside", "base", "basefont", "blockquote", "body", "caption",
  "center", "col", "colgroup", "dd", "details", "dialog", "dir", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "frame", "frameset", "h1", "h2",
  "h3", "h4", "h5", "h6", "head", "header", "hr", "html", "iframe", "legend", "li",
  "link", "main", "menu", "menuitem", "nav", "noframes", "ol", "optgroup", "option", "p",
  "param", "search", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead",
  "title", "tr", "track", "ul",
]);

function isFenceOpener(match: RegExpMatchArray): boolean {
  return match.groups!["marker"]![0] === "~" || !match.groups!["rest"]!.includes("`");
}

function backtickRunEnd(text: string, start: number): number {
  let end = start;
  while (text[end] === "`") end += 1;
  return end;
}

function isBackslashEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function matchingBacktickRunEnd(
  text: string,
  searchStart: number,
  delimiterLength: number,
): number | null {
  let search = searchStart;

  while (search < text.length) {
    const closingStart = text.indexOf("`", search);
    if (closingStart === -1) return null;
    const closingEnd = backtickRunEnd(text, closingStart);
    if (closingEnd - closingStart === delimiterLength) return closingEnd;
    search = closingEnd;
  }
  return null;
}

interface BacktickEnd {
  readonly line: number;
  readonly end: number;
}

function isHtmlBlockStart(text: string): boolean {
  const content = text.match(/^ {0,3}(\S.*)$/)?.[1];
  if (content === undefined) return false;
  if (
    content.startsWith("<?") ||
    content.startsWith("<![CDATA[") ||
    /^<![A-Z]/.test(content) ||
    /^<(?:script|pre|style|textarea)(?:[ \t]|>|$)/i.test(content)
  ) {
    return true;
  }
  const blockTag = content.match(/^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t]|\/?>|$)/);
  return blockTag !== null && HTML_BLOCK_TAGS.has(blockTag[1]!.toLowerCase());
}

function isClosedHtmlCommentBlockStart(lines: readonly string[], line: number): boolean {
  if (!/^ {0,3}<!--/.test(lines[line]!)) return false;
  return lines.slice(line).some((text) => text.includes("-->"));
}

function codeSpanBoundary(text: string): boolean {
  if (
    pythonStrip(text) === "" ||
    PARAGRAPH_INTERRUPT_RE.test(text) ||
    THEMATIC_BREAK_RE.test(text) ||
    SETEXT_HEADING_RE.test(text) ||
    TABLE_DELIMITER_ROW_RE.test(text) ||
    isHtmlBlockStart(text)
  ) {
    return true;
  }
  const fence = text.match(FENCE_RE);
  return fence !== null && isFenceOpener(fence);
}

function matchingBacktickEnd(
  lines: readonly string[],
  openingLine: number,
  openingStart: number,
): BacktickEnd | null {
  const openingEnd = backtickRunEnd(lines[openingLine]!, openingStart);
  const delimiterLength = openingEnd - openingStart;

  for (let line = openingLine; line < lines.length; line += 1) {
    const text = lines[line]!;
    if (
      line > openingLine &&
      (codeSpanBoundary(text) || isClosedHtmlCommentBlockStart(lines, line))
    ) {
      return null;
    }
    const end = matchingBacktickRunEnd(
      text,
      line === openingLine ? openingEnd : 0,
      delimiterLength,
    );
    if (end !== null) return { line, end };
  }
  return null;
}

function maskHtmlComments(lines: readonly string[]): readonly string[] {
  let fenceCharacter = "";
  let fenceLength = 0;
  let openComment = false;
  let codeSpanLength = 0;

  const masked = lines.map((text, index) => {
    if (fenceCharacter) {
      const fence = text.match(FENCE_RE);
      if (fence) {
        const marker = fence.groups!["marker"]!;
        if (
          marker[0] === fenceCharacter &&
          marker.length >= fenceLength &&
          pythonStrip(fence.groups!["rest"]!) === ""
        ) {
          fenceCharacter = "";
          fenceLength = 0;
        }
      }
      return text;
    }

    if (!openComment && codeSpanLength === 0) {
      const fence = text.match(FENCE_RE);
      if (fence && isFenceOpener(fence)) {
        const marker = fence.groups!["marker"]!;
        fenceCharacter = marker[0]!;
        fenceLength = marker.length;
        return text;
      }
    }

    let cursor = 0;
    let visible = "";
    for (;;) {
      if (codeSpanLength > 0) {
        const closingEnd = matchingBacktickRunEnd(text, cursor, codeSpanLength);
        if (closingEnd === null) return visible + text.slice(cursor);
        visible += text.slice(cursor, closingEnd);
        codeSpanLength = 0;
        cursor = closingEnd;
        continue;
      }
      if (openComment) {
        const end = text.indexOf("-->", cursor);
        if (end === -1) return visible;
        openComment = false;
        cursor = end + 3;
        continue;
      }
      const start = text.indexOf("<!--", cursor);
      const backtick = text.indexOf("`", cursor);
      if (backtick !== -1 && (start === -1 || backtick < start)) {
        if (isBackslashEscaped(text, backtick)) {
          visible += text.slice(cursor, backtick + 1);
          cursor = backtick + 1;
          continue;
        }
        const openingEnd = backtickRunEnd(text, backtick);
        const closing = matchingBacktickEnd(lines, index, backtick);
        if (closing === null) {
          visible += text.slice(cursor, openingEnd);
          cursor = openingEnd;
        } else if (closing.line === index) {
          visible += text.slice(cursor, closing.end);
          cursor = closing.end;
        } else {
          visible += text.slice(cursor);
          codeSpanLength = openingEnd - backtick;
          return visible;
        }
        continue;
      }
      if (start === -1) return visible + text.slice(cursor);
      visible += text.slice(cursor, start);
      openComment = true;
      cursor = start + 4;
    }
  });
  return masked;
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
  const visibleLines = maskHtmlComments(lines);
  const all: Heading[] = headings(visibleLines);
  const fenced = new Set(lines.map((_, index) => index + 1));
  for (const content of contentLines(visibleLines)) fenced.delete(content.line);

  const blocks: DetailBlock[] = [];

  all.forEach((heading, index) => {
    const match = heading.text.match(ID_HEADING_RE);
    if (!match) return;

    const level = headingLevel(visibleLines[heading.line - 1] ?? "");
    const next = all
      .slice(index + 1)
      .find((candidate) => ID_HEADING_RE.test(candidate.text) ||
        headingLevel(visibleLines[candidate.line - 1] ?? "") <= level);
    const lastLine = (next ? next.line - 1 : lines.length);

    const bodyLines = [];
    for (let line = heading.line + 1; line <= lastLine; line += 1) {
      bodyLines.push({ line, text: visibleLines[line - 1] ?? "", fenced: fenced.has(line) });
    }

    let endLine = heading.line;
    for (const body of bodyLines) {
      if ((lines[body.line - 1] ?? "").trim().length > 0) endLine = body.line;
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
