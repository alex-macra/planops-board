/**
 * Surgical Markdown table edits.
 *
 * Every edit rewrites only a cell's value core, the exact substring
 * `clean_cell` would have been left with. Pipes, alignment padding, surrounding
 * whitespace and `code` decoration are preserved byte for byte, so `git diff`
 * shows one changed value and nothing else.
 */
import { contentLines, extractTables, splitRow } from "./parse.ts";

export class ConflictError extends Error {
  override readonly name = "ConflictError";
}

export class PatchError extends Error {
  override readonly name = "PatchError";
}

export interface CellEdit {
  readonly line: number;
  readonly column: number;
  /** Value the client believed was there; a mismatch aborts the write. */
  readonly expected: string;
  readonly value: string;
}

export interface RowMove {
  readonly fromLine: number;
  readonly toLine: number;
}

export interface LineInsert {
  /** Insert after this line. 0 puts the lines at the top of the document. */
  readonly afterLine: number;
  /** That line's exact current text; a mismatch aborts, as a cell edit does. */
  readonly expectedAfterText: string;
  readonly lines: readonly string[];
}

function splitLines(text: string): string[] {
  return text.split("\n");
}

function escapeCellValue(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new PatchError("a table cell cannot contain a line break");
  }
  return value.replaceAll("|", "\\|");
}

/**
 * Apply cell edits to one document. Edits are validated against `expected`
 * before anything is written, so a partially-applied patch is impossible.
 */
export function patchCells(text: string, edits: readonly CellEdit[]): string {
  const lines = splitLines(text);

  for (const edit of edits) {
    const original = lines[edit.line - 1];
    if (original === undefined) {
      throw new ConflictError(`line ${edit.line} does not exist`);
    }

    const { cells, spans } = splitRow(original);
    const current = cells[edit.column];
    const span = spans[edit.column];
    if (current === undefined || span === undefined) {
      throw new ConflictError(
        `line ${edit.line} has ${cells.length} cells; column ${edit.column} is out of range`,
      );
    }
    if (current !== edit.expected) {
      throw new ConflictError(
        `line ${edit.line} column ${edit.column} is ${JSON.stringify(current)}, ` +
          `expected ${JSON.stringify(edit.expected)}`,
      );
    }

    lines[edit.line - 1] =
      original.slice(0, span.coreStart) +
      escapeCellValue(edit.value) +
      original.slice(span.coreEnd);
  }

  return lines.join("\n");
}

/** Line spans a table occupies, header and delimiter included. */
function tableSpans(lines: readonly string[]): { first: number; last: number }[] {
  return extractTables(lines).flatMap((table) => {
    const last = table.rows[table.rows.length - 1]?.line;
    if (last === undefined) return [];
    return [{ first: table.headerLine ?? last, last }];
  });
}

const CONFLICT_RE = /^(?:<{7,}(?:\s|$)|\|{7,}(?:\s|$)|={7,}\s*$|>{7,}(?:\s|$))/;

/**
 * Insert whole lines at a guarded position.
 *
 * The third and last thing the board writes, after a cell's value core and a
 * row move. Prose needs it: a note has nowhere to live inside a table cell, and
 * rows with no `### ID - Title` block need one created.
 *
 * This guards the document structure so the insert cannot land inside a
 * table or a code block, and cannot smuggle in a conflict marker or a line
 * break. Structural validation decides whether the result is valid, and the
 * writer rolls it back on refusal.
 *
 * One insert per write: two would need the second's line number to account for
 * the first, and nothing here needs that.
 */
export function insertLines(text: string, insert: LineInsert): string {
  const lines = splitLines(text);

  if (!Number.isInteger(insert.afterLine) || insert.afterLine < 0 || insert.afterLine > lines.length) {
    throw new PatchError(`cannot insert after line ${insert.afterLine}`);
  }

  const anchor = insert.afterLine === 0 ? "" : lines[insert.afterLine - 1]!;
  if (anchor !== insert.expectedAfterText) {
    throw new ConflictError(
      `line ${insert.afterLine} is ${JSON.stringify(anchor)}, ` +
        `expected ${JSON.stringify(insert.expectedAfterText)}`,
    );
  }

  for (const span of tableSpans(lines)) {
    if (insert.afterLine >= span.first && insert.afterLine < span.last) {
      throw new PatchError(
        `line ${insert.afterLine} is inside the table at line ${span.first}; ` +
          "a row cannot be separated from the header that defines its columns",
      );
    }
  }

  const fenced = new Set(lines.map((_, index) => index + 1));
  for (const content of contentLines(lines)) fenced.delete(content.line);
  if (fenced.has(insert.afterLine)) {
    throw new PatchError(`line ${insert.afterLine} is inside a fenced code block`);
  }

  for (const line of insert.lines) {
    if (/[\r\n]/.test(line)) {
      throw new PatchError("an inserted line cannot contain a line break");
    }
    if (CONFLICT_RE.test(line)) {
      throw new PatchError("an inserted line cannot look like a conflict marker");
    }
  }

  lines.splice(insert.afterLine, 0, ...insert.lines);
  return lines.join("\n");
}

/**
 * Move one table row to another position in the same table body.
 *
 * Cross-table and cross-document moves are impossible in Markdown. A row is
 * bound to the table whose header defines its columns, so they are rejected
 * rather than silently approximated.
 */
export function moveRow(text: string, move: RowMove): string {
  const lines = splitLines(text);
  const tables = extractTables(lines);

  const table = tables.find((candidate) =>
    candidate.rows.some((row) => row.line === move.fromLine),
  );
  if (!table) {
    throw new PatchError(`line ${move.fromLine} is not a table row`);
  }
  if (!table.rows.some((row) => row.line === move.toLine)) {
    throw new PatchError(
      `line ${move.toLine} is not a row of the same table; rows cannot move between tables`,
    );
  }
  if (move.fromLine === move.toLine) return text;

  const fromIndex = move.fromLine - 1;
  const toIndex = move.toLine - 1;
  const [moved] = lines.splice(fromIndex, 1);
  lines.splice(toIndex, 0, moved!);
  return lines.join("\n");
}
