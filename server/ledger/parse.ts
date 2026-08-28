/** Markdown table extraction with byte offsets for guarded cell edits. */

const FENCE_RE = /^ {0,3}(?<marker>`{3,}|~{3,})(?<rest>.*)$/;
const HEADING_RE = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const SETEXT_HEADING_RE = /^ {0,3}(?:=+|-+)\s*$/;
const TABLE_DELIMITER_RE = /^:?-{3,}:?$/;
const CELL_SEPARATOR_RE = /(?<!\\)\|/g;
const WRAPPER_CHARACTERS = "`*_";

export interface ContentLine {
  readonly line: number;
  readonly text: string;
}

export interface Heading {
  readonly line: number;
  readonly text: string;
}

/** Byte span of one cell's raw segment, and of its value core inside it. */
export interface CellSpan {
  readonly start: number;
  readonly end: number;
  readonly coreStart: number;
  readonly coreEnd: number;
}

export interface TableRow {
  readonly line: number;
  readonly cells: readonly string[];
  readonly spans: readonly CellSpan[];
  readonly text: string;
}

export interface Table {
  readonly header: readonly string[];
  readonly headerLine: number | null;
  readonly section: string | null;
  readonly rows: readonly TableRow[];
}

/**
 * Python's `str.strip()` treats \x1c-\x1f and \x85 as whitespace where
 * JavaScript's `trim()` does not, and ignores \ufeff where `trim()` strips it.
 * Match Python exactly so cell values agree with the validator.
 */
const PYTHON_SPACE =
  /[\t\n\v\f\r\x1c-\x1f\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

function isSpace(character: string): boolean {
  return PYTHON_SPACE.test(character);
}

function leadingSpaceLength(value: string): number {
  let index = 0;
  while (index < value.length && isSpace(value[index]!)) index += 1;
  return index;
}

function trailingSpaceStart(value: string, from: number): number {
  let index = value.length;
  while (index > from && isSpace(value[index - 1]!)) index -= 1;
  return index;
}

export function pythonStrip(value: string): string {
  const start = leadingSpaceLength(value);
  return value.slice(start, trailingSpaceStart(value, start));
}

function isFenceOpener(match: RegExpMatchArray): boolean {
  const marker = match.groups!["marker"]!;
  return marker[0] === "~" || !match.groups!["rest"]!.includes("`");
}

/** Lines outside fenced code blocks, indexed from one. */
export function contentLines(lines: readonly string[]): ContentLine[] {
  const content: ContentLine[] = [];
  let fenceCharacter = "";
  let fenceLength = 0;

  lines.forEach((text, index) => {
    const fence = text.match(FENCE_RE);
    if (fenceCharacter) {
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
      return;
    }

    if (fence && isFenceOpener(fence)) {
      const marker = fence.groups!["marker"]!;
      fenceCharacter = marker[0]!;
      fenceLength = marker.length;
      return;
    }

    content.push({ line: index + 1, text });
  });

  return content;
}

/** ATX and setext headings. */
export function headings(lines: readonly string[]): Heading[] {
  const found: Heading[] = [];
  let previous: ContentLine | null = null;

  for (const { line, text } of contentLines(lines)) {
    const heading = text.match(HEADING_RE);
    if (heading) {
      found.push({ line, text: heading[1]! });
    } else if (
      SETEXT_HEADING_RE.test(text) &&
      previous !== null &&
      previous.line === line - 1 &&
      pythonStrip(previous.text) !== "" &&
      !HEADING_RE.test(previous.text)
    ) {
      found.push({ line: previous.line, text: pythonStrip(previous.text) });
    }
    previous = { line, text };
  }

  return found;
}

/** Unescape pipes, then peel symmetric Markdown wrappers. */
export function cleanCell(cell: string): string {
  let value = pythonStrip(cell).replaceAll("\\|", "|");
  while (
    value.length >= 2 &&
    value[0] === value[value.length - 1] &&
    WRAPPER_CHARACTERS.includes(value[0]!)
  ) {
    value = pythonStrip(value.slice(1, -1));
  }
  return value;
}

/**
 * Locate the value core inside a raw cell segment: the substring clean_cell
 * would be left with, before pipe unescaping. Offsets are relative to `segment`.
 *
 * The patcher rewrites only this range, so surrounding whitespace, alignment
 * padding and `code fences` survive an edit byte for byte.
 */
export function cellCore(segment: string): { start: number; end: number } {
  let start = leadingSpaceLength(segment);
  let end = trailingSpaceStart(segment, start);

  while (
    end - start >= 2 &&
    segment[start] === segment[end - 1] &&
    WRAPPER_CHARACTERS.includes(segment[start]!)
  ) {
    const innerStart = start + 1;
    const innerEnd = end - 1;
    const trimmedStart = innerStart + leadingSpaceLength(segment.slice(innerStart, innerEnd));
    const trimmedEnd = trailingSpaceStart(segment.slice(0, innerEnd), trimmedStart);
    start = trimmedStart;
    end = trimmedEnd;
  }

  return { start, end };
}

/** Split a table row and report each cell's byte span. */
export function splitRow(text: string): { cells: string[]; spans: CellSpan[] } {
  const contentStart = leadingSpaceLength(text);
  const contentEnd = trailingSpaceStart(text, contentStart);

  let start = contentStart;
  let end = contentEnd;
  if (text.slice(start, end).startsWith("|")) start += 1;
  const body = text.slice(start, end);
  if (body.endsWith("|") && !body.endsWith("\\|")) end -= 1;

  const region = text.slice(start, end);
  const cells: string[] = [];
  const spans: CellSpan[] = [];

  let cursor = 0;
  CELL_SEPARATOR_RE.lastIndex = 0;
  for (const match of region.matchAll(CELL_SEPARATOR_RE)) {
    pushCell(region.slice(cursor, match.index), start + cursor);
    cursor = match.index + 1;
  }
  pushCell(region.slice(cursor), start + cursor);

  function pushCell(segment: string, offset: number): void {
    const core = cellCore(segment);
    cells.push(cleanCell(segment));
    spans.push({
      start: offset,
      end: offset + segment.length,
      coreStart: offset + core.start,
      coreEnd: offset + core.end,
    });
  }

  return { cells, spans };
}

function isTableDelimiter(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => TABLE_DELIMITER_RE.test(cell));
}

function enclosingSection(sections: readonly Heading[], line: number): string | null {
  let section: string | null = null;
  for (const heading of sections) {
    if (heading.line >= line) break;
    section = heading.text;
  }
  return section;
}

/** Extract tables with section attribution and header line numbers. */
export function extractTables(lines: readonly string[]): Table[] {
  const content = contentLines(lines);
  const sections = headings(lines);
  const tables: Table[] = [];

  let index = 0;
  while (index + 1 < content.length) {
    const headerEntry = content[index]!;
    const delimiterEntry = content[index + 1]!;
    if (!headerEntry.text.includes("|") || delimiterEntry.line !== headerEntry.line + 1) {
      index += 1;
      continue;
    }

    const header = splitRow(headerEntry.text);
    const delimiter = splitRow(delimiterEntry.text);
    if (header.cells.length !== delimiter.cells.length || !isTableDelimiter(delimiter.cells)) {
      index += 1;
      continue;
    }

    const rows: TableRow[] = [];
    let cursor = index + 2;
    let previousLine = delimiterEntry.line;
    while (cursor < content.length) {
      const entry = content[cursor]!;
      if (entry.line !== previousLine + 1 || !entry.text.includes("|")) break;
      const row = splitRow(entry.text);
      rows.push({ line: entry.line, cells: row.cells, spans: row.spans, text: entry.text });
      previousLine = entry.line;
      cursor += 1;
    }

    const firstLine = rows[0]?.line ?? null;
    tables.push({
      header: header.cells,
      headerLine: firstLine === null ? null : firstLine - 2,
      section: firstLine === null ? null : enclosingSection(sections, firstLine),
      rows,
    });
    index = cursor;
  }

  return tables;
}
