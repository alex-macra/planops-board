/**
 * Composing a note into a ledger.
 *
 * Notes are the one thing here that is genuinely new data: the corpus records
 * scope, criteria and evidence, and git records when a status moved, but
 * nothing records "why is this still sitting here". They go into the task's own
 * `### ID - Title` block rather than a sidecar, so it stays beside the task.
 *
 * This module only decides *what lines to insert where*. The guard that the
 * position is still what the client saw, and that the result passes the
 * validator, stays in patch.ts and write.ts.
 */
import {
  conventionalHeadingLevel,
  extractDetailBlocks,
  type DetailBlock,
} from "./detail.ts";
import { headings } from "./parse.ts";
import type { LineInsert } from "./patch.ts";

export class NoteError extends Error {
  override readonly name = "NoteError";
}

/** The corpus wraps at 79 columns; continuations are indented two spaces. */
const WIDTH = 79;
const INDENT = "  ";

/**
 * Characters that would turn a wrapped continuation into a block construct.
 *
 * A two-space indent is still within Markdown's zero-to-three space allowance, so a line
 * beginning `# ` or `> ` there really would become a heading or a quote. Rather
 * than escape it after the fact, the wrapper never breaks before such a word.
 */
const OPENS_A_BLOCK_RE = /^(?:[#>|=~`*+-]|\d+[.)])/;

/**
 * Wrap `rest` after `first`, breaking only at spaces.
 *
 * A word is never split, which is what keeps a URL or a full commit SHA intact
 * however long it is: an over-long line is a cosmetic problem, a URL broken
 * across two lines is a wrong one.
 */
export function wrap(first: string, rest: string, indent: string = INDENT): string[] {
  const words = rest.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let line = first;
  let continuation = "";

  for (const word of words) {
    const candidate = line.length === 0 ? `${continuation}${word}` : `${line} ${word}`;
    const startsBlock = OPENS_A_BLOCK_RE.test(word);
    if (candidate.length <= WIDTH || line.length === 0 || startsBlock) {
      line = candidate;
      continue;
    }
    lines.push(line);
    continuation = indent;
    line = `${continuation}${word}`;
  }

  if (line.length > 0) lines.push(line);
  return lines;
}

/** One line of prose: newlines and runs of space collapse to single spaces. */
export function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function today(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function noteLines(text: string, date: string): string[] {
  const body = normalise(text);
  if (body.length === 0) throw new NoteError("a note needs some text");
  return wrap(`- **Note (${date}):**`, body);
}

export interface NoteRequest {
  readonly taskId: string;
  readonly text: string;
  readonly title?: string | undefined;
  readonly date?: string | undefined;
}

export interface NotePlan {
  readonly insert: LineInsert;
  /** True when the note also created the task's `### ID - Title` block. */
  readonly createsBlock: boolean;
}

function lastLine(lines: readonly string[]): number {
  for (let line = lines.length; line > 0; line -= 1) {
    if ((lines[line - 1] ?? "").trim().length > 0) return line;
  }
  return 0;
}

/**
 * Where a new block goes: after the last one in the document, which keeps it in
 * whatever section already holds them, usually `## Work items`.
 * A document with no blocks at all gets a trailing section of its own.
 */
function blockInsertPoint(
  lines: readonly string[],
  blocks: readonly DetailBlock[],
  heading: string,
): { afterLine: number; prefix: string[] } {
  if (blocks.length > 0) {
    const last = blocks.reduce((a, b) => (b.headingLine > a.headingLine ? b : a));
    const level = "#".repeat(conventionalHeadingLevel(blocks));
    return {
      afterLine: last.endLine,
      prefix: ["", `${level} ${heading}`, ""],
    };
  }

  const hasNotesSection = headings(lines).some((heading) => heading.text === "Notes");
  return {
    afterLine: lastLine(lines),
    prefix: hasNotesSection
      ? ["", `### ${heading}`, ""]
      : ["", "## Notes", "", `### ${heading}`, ""],
  };
}

/** Callers check cross-document heading uniqueness before creating a block. */
export function planNote(text: string, request: NoteRequest): NotePlan {
  const body = noteLines(request.text, request.date ?? today());
  const lines = text.split("\n");
  const blocks = extractDetailBlocks(lines, "");
  const block = blocks.find((candidate) => candidate.id === request.taskId);

  if (block) {
    return {
      insert: {
        afterLine: block.endLine,
        expectedAfterText: lines[block.endLine - 1] ?? "",
        lines: body,
      },
      createsBlock: false,
    };
  }

  if (!request.title?.trim()) {
    throw new NoteError(
      `${request.taskId} has no detail block yet; a title is needed to create one`,
    );
  }

  const heading = `${request.taskId} - ${normalise(request.title)}`;
  const { afterLine, prefix } = blockInsertPoint(lines, blocks, heading);
  return {
    insert: {
      afterLine,
      expectedAfterText: afterLine === 0 ? "" : (lines[afterLine - 1] ?? ""),
      lines: [...prefix, ...body],
    },
    createsBlock: true,
  };
}
