/**
 * Typed subtasks from a task's `- **Subtasks:**` checklist.
 *
 * The checklist already parses as a `Subtasks` detail field whose items are the
 * bullet text with the leading `- ` stripped. This layer reads those items and
 * never touches the task, story, or detail parsers: a subtask is a child of the
 * block it sits under, not a ledger row, so it carries no status of its own.
 */
import type { DetailBlock } from "./detail.ts";

/** `[ ] POB-AUTH-003.1 title [@owner]`: a checkbox, a dotted id, a title, an owner. */
const SUBTASK_LINE_RE =
  /^\[(?<box>[ xX])\]\s+(?<id>[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\.\d+)(?:\s+(?<title>.*?))?(?:\s+\[@(?<owner>[^\]]+)\])?\s*$/u;

export interface Subtask {
  /** The dotted child id, e.g. `POB-AUTH-003.1`. */
  readonly id: string;
  /** The enclosing task id. The checklist's parent is structural, not the id prefix. */
  readonly parentTaskId: string;
  readonly title: string;
  readonly done: boolean;
  readonly owner: string | null;
}

export interface SubtaskParse {
  readonly subtasks: readonly Subtask[];
  /** `Subtasks` items that did not match the grammar, so a caller can flag them. */
  readonly malformed: readonly string[];
}

const EMPTY: SubtaskParse = { subtasks: [], malformed: [] };

/** Only a `Subtasks` field carries a checklist; a block has at most one in practice. */
function checklistItems(block: DetailBlock): readonly string[] {
  return block.fields.filter((field) => field.label === "Subtasks").flatMap((field) => field.items);
}

/** Parse the checklist under one block. A malformed line is returned, never dropped. */
export function parseSubtasks(block: DetailBlock): SubtaskParse {
  const items = checklistItems(block);
  if (items.length === 0) return EMPTY;

  const subtasks: Subtask[] = [];
  const malformed: string[] = [];
  for (const item of items) {
    const groups = item.match(SUBTASK_LINE_RE)?.groups;
    if (!groups) {
      malformed.push(item);
      continue;
    }
    subtasks.push({
      id: groups["id"]!,
      parentTaskId: block.id,
      title: (groups["title"] ?? "").trim(),
      done: groups["box"] !== " ",
      owner: groups["owner"] ? groups["owner"].trim() : null,
    });
  }
  return { subtasks, malformed };
}
