import type { WorkflowConfig } from "../../shared/config.ts";
import { extractDetailBlocks, type DetailBlock } from "./detail.ts";
import { buildBoard, type SourceDocument } from "./model.ts";
import { applyLineChanges, PatchError, type LineChanges, type LineInsert, type LineReplace } from "./patch.ts";
import { contentLines, eligibleTaskTable, extractTables, headings, splitRow, type Table } from "./parse.ts";
import { documentVocabulary, parseStatus, TASK_ID_HEADERS } from "./statuses.ts";
import { isStoryId, storyOf } from "./stories.ts";
import { parseSubtasks } from "./subtasks.ts";

export type AuthorOperation =
  | { readonly operation: "create.story"; readonly id: string; readonly title: string; readonly outcome: string; readonly soThat: string; readonly kind?: "story" | "enabler" | undefined; readonly role?: string | undefined; readonly demo?: string | undefined }
  | { readonly operation: "create.task"; readonly id: string; readonly storyId: string; readonly title: string; readonly tableHeaderLine: number; readonly cells: Readonly<Record<string, string>> }
  | { readonly operation: "create.subtask"; readonly taskId: string; readonly id: string; readonly title: string; readonly owner?: string | undefined }
  | { readonly operation: "toggle.subtask"; readonly taskId: string; readonly id: string };

const TASK_ID_RE = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;
const SUBTASK_ID_RE = /^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\.\d+$/;
const FIELD_RE = /^- \*\*[^*]+:\*\*/;
const CHECKLIST_RE = /^  - \[(?<box>[ xX])\] (?<id>[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\.\d+) (?<title>.+?)(?: \[@(?<owner>[^\]]+)\])?$/u;
function plain(value: string, name: string): string {
  if (!value || value !== value.trim() || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) ||
      value.includes("<!--") || value.includes("-->")) {
    throw new PatchError(`${name} must be one nonblank plain line`);
  }
  return value;
}

function cellValue(value: string, name: string): string {
  if (value !== value.trim() || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) ||
      value.includes("<!--") || value.includes("-->")) {
    throw new PatchError(`${name} must be one plain table cell`);
  }
  return value;
}

function insert(lines: readonly string[], afterLine: number, added: readonly string[]): LineInsert {
  return { afterLine, expectedAfterText: afterLine === 0 ? "" : lines[afterLine - 1]!, lines: added };
}

function section(lines: readonly string[], name: string): { start: number; end: number; last: number } {
  const matches = headings(lines).filter((heading) => heading.text === name);
  if (matches.length !== 1 || !/^##\s/.test(lines[matches[0]!.line - 1] ?? "")) {
    throw new PatchError(`expected exactly one ## ${name} section`);
  }
  const start = matches[0]!.line;
  const next = contentLines(lines).find((entry) => entry.line > start && /^#{1,2}\s/.test(entry.text));
  const end = next ? next.line - 1 : lines.length;
  let last = start;
  for (let line = start + 1; line <= end; line += 1) {
    if ((lines[line - 1] ?? "").trim()) last = line;
  }
  return { start, end, last };
}

function corpusBlocks(documents: readonly SourceDocument[]): DetailBlock[] {
  return documents.flatMap((document) => extractDetailBlocks(document.text.split("\n"), document.path));
}

function rowsWithId(documents: readonly SourceDocument[], id: string): number {
  return documents.flatMap((document) => extractTables(document.text.split("\n")))
    .filter((table) => TASK_ID_HEADERS.has(table.header[0] ?? ""))
    .flatMap((table) => table.rows)
    .filter((row) => row.cells[0] === id).length;
}

function unusedId(documents: readonly SourceDocument[], blocks: readonly DetailBlock[], id: string): void {
  if (blocks.some((block) => block.id === id) || rowsWithId(documents, id) > 0) {
    throw new PatchError(`${id} is already used in the planning corpus`);
  }
}

function uniqueBlock(blocks: readonly DetailBlock[], file: string, id: string): DetailBlock {
  const matches = blocks.filter((block) => block.id === id);
  if (matches.length !== 1 || matches[0]!.file !== file) {
    throw new PatchError(`${id} needs exactly one detail block in ${file}`);
  }
  return matches[0]!;
}

function taskBlock(blocks: readonly DetailBlock[], documents: readonly SourceDocument[], file: string, id: string): DetailBlock {
  if (!TASK_ID_RE.test(id) || isStoryId(id) || rowsWithId(documents, id) !== 1) {
    throw new PatchError(`${id} needs exactly one task row`);
  }
  return uniqueBlock(blocks, file, id);
}

function fieldLines(lines: readonly string[], block: DetailBlock, label: string): number[] {
  const marker = `- **${label}:**`;
  const matches: number[] = [];
  for (let line = block.headingLine + 1; line <= block.endLine; line += 1) {
    if ((lines[line - 1] ?? "").startsWith(marker)) matches.push(line);
  }
  return matches;
}

function checklist(lines: readonly string[], block: DetailBlock): { label: number; entries: { line: number; id: string; box: string }[] } | null {
  const labels = fieldLines(lines, block, "Subtasks");
  if (labels.length > 1 || block.fields.filter((field) => field.label === "Subtasks").length > 1) {
    throw new PatchError(`${block.id} has ambiguous Subtasks fields`);
  }
  if (labels.length === 0) {
    if (block.fields.some((field) => field.label === "Subtasks")) {
      throw new PatchError(`${block.id} has an unsupported Subtasks field`);
    }
    return null;
  }
  const label = labels[0]!;
  if (lines[label - 1] !== "- **Subtasks:**" || parseSubtasks(block).malformed.length > 0) {
    throw new PatchError(`${block.id} has a malformed Subtasks checklist`);
  }
  const entries: { line: number; id: string; box: string }[] = [];
  for (let line = label + 1; line <= block.endLine; line += 1) {
    const value = lines[line - 1] ?? "";
    if (FIELD_RE.test(value)) break;
    if (!value.trim()) continue;
    const groups = value.match(CHECKLIST_RE)?.groups;
    if (!groups || !groups["title"]?.trim()) {
      throw new PatchError(`${block.id} has a malformed Subtasks checklist`);
    }
    entries.push({ line, id: groups["id"]!, box: groups["box"]! });
  }
  if (entries.some((entry) => entry.id.match(SUBTASK_ID_RE)?.[1] !== block.id) ||
      new Set(entries.map((entry) => entry.id)).size !== entries.length ||
      entries.length !== parseSubtasks(block).subtasks.length) {
    throw new PatchError(`${block.id} has an ambiguous Subtasks checklist`);
  }
  return { label, entries };
}

function planStory(lines: readonly string[], documents: readonly SourceDocument[], blocks: readonly DetailBlock[], request: Extract<AuthorOperation, { operation: "create.story" }>): LineChanges {
  if (!isStoryId(request.id)) throw new PatchError("story ID does not match the parser grammar");
  unusedId(documents, blocks, request.id);
  const fields = [
    ...(request.kind ? [`- **Kind:** ${request.kind}`] : []),
    ...(request.role ? [`- **Role:** ${plain(request.role, "role")}`] : []),
    `- **Outcome:** ${plain(request.outcome, "outcome")}`,
    `- **So that:** ${plain(request.soThat, "soThat")}`,
    ...(request.demo ? [`- **Demo:** ${plain(request.demo, "demo")}`] : []),
    "- **Delivered by:**",
  ];
  const target = section(lines, "Stories");
  return { inserts: [insert(lines, target.last, ["", `### ${request.id} - ${plain(request.title, "title")}`, "", ...fields])], replacements: [] };
}

function taskTable(lines: readonly string[], request: Extract<AuthorOperation, { operation: "create.task" }>, workflow: WorkflowConfig): Table {
  const tables = extractTables(lines);
  const matches = tables.filter((table) => table.headerLine === request.tableHeaderLine);
  if (matches.length !== 1) throw new PatchError("task table header anchor is missing or ambiguous");
  const table = matches[0]!;
  if (!eligibleTaskTable(table)) {
    throw new PatchError("task table has unsupported or malformed columns or rows");
  }
  const expected = table.header.slice(1);
  if (Object.keys(request.cells).length !== expected.length ||
      expected.some((name) => !Object.hasOwn(request.cells, name))) {
    throw new PatchError("cells must match every non-ID table header exactly");
  }
  const status = request.cells["Status"];
  if (status !== undefined && parseStatus(status, documentVocabulary(tables, workflow.statusOrder).bases).base === null) {
    throw new PatchError("task status is outside the document vocabulary");
  }
  for (const name of ["Priority", "Severity", "Severity/risk"]) {
    const value = request.cells[name];
    if (value !== undefined && value !== "" && !workflow.priorityOrder.includes(value)) {
      throw new PatchError(`${name} is outside the configured priority order`);
    }
  }
  return table;
}

function planTask(lines: readonly string[], file: string, documents: readonly SourceDocument[], blocks: readonly DetailBlock[], request: Extract<AuthorOperation, { operation: "create.task" }>, workflow: WorkflowConfig): LineChanges {
  if (!TASK_ID_RE.test(request.id) || isStoryId(request.id)) throw new PatchError("task ID does not match the parser grammar");
  unusedId(documents, blocks, request.id);
  const story = uniqueBlock(blocks, file, request.storyId);
  if (!isStoryId(request.storyId) || !storyOf(story, "")) throw new PatchError("story is incomplete or invalid");
  const storySection = section(lines, "Stories");
  if (story.headingLine <= storySection.start || story.headingLine > storySection.end) {
    throw new PatchError("story is outside the Stories section");
  }
  const labels = fieldLines(lines, story, "Delivered by");
  if (labels.length !== 1 || story.fields.filter((field) => field.label === "Delivered by").length !== 1) {
    throw new PatchError("story needs exactly one Delivered by field");
  }
  for (const block of blocks.filter((candidate) => isStoryId(candidate.id))) {
    if (block.fields.some((field) => field.label === "Delivered by" && field.items.some((item) => item.includes(`\`${request.id}\``)))) {
      throw new PatchError(`${request.id} is already linked by a story`);
    }
  }
  const linkLine = labels[0]!;
  const current = lines[linkLine - 1]!;
  if (!/^- \*\*Delivered by:\*\*(?:\s*`[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+`(?:, `[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+`)*)?\s*$/.test(current)) {
    throw new PatchError("Delivered by field is not a single canonical ID list");
  }
  for (let line = linkLine + 1; line <= story.endLine; line += 1) {
    const value = lines[line - 1] ?? "";
    if (FIELD_RE.test(value)) break;
    if (value.trim()) throw new PatchError("Delivered by field has an ambiguous continuation");
  }
  const table = taskTable(lines, request, workflow);
  const values = table.header.slice(1).map((name) => cellValue(request.cells[name]!, name).replaceAll("|", "\\|"));
  const row = `| \`${request.id}\` | ${values.join(" | ")} |`;
  const parsed = splitRow(row).cells;
  if (parsed.length !== table.header.length || parsed[0] !== request.id ||
      table.header.slice(1).some((name, index) => parsed[index + 1] !== request.cells[name])) {
    throw new PatchError("task row cannot round-trip through the table parser");
  }
  const details = section(lines, "Task details");
  const rowAfter = table.rows.at(-1)?.line ?? table.headerLine! + 1;
  const linked = `${current.trimEnd()}${current.trimEnd().endsWith("**") ? " " : ", "}\`${request.id}\``;
  return {
    inserts: [
      insert(lines, rowAfter, [row]),
      insert(lines, details.last, ["", `### ${request.id} - ${plain(request.title, "title")}`]),
    ],
    replacements: [{ line: linkLine, expected: current, value: linked }],
  };
}

function planSubtask(lines: readonly string[], file: string, documents: readonly SourceDocument[], blocks: readonly DetailBlock[], request: Extract<AuthorOperation, { operation: "create.subtask" }>): LineChanges {
  const match = request.id.match(SUBTASK_ID_RE);
  if (!match || match[1] !== request.taskId) throw new PatchError("subtask ID must share its parent task ID");
  const block = taskBlock(blocks, documents, file, request.taskId);
  if (blocks.some((candidate) => parseSubtasks(candidate).subtasks.some((subtask) => subtask.id === request.id))) {
    throw new PatchError(`${request.id} is already used in the planning corpus`);
  }
  const owner = request.owner ? ` [@${plain(request.owner, "owner")}]` : "";
  if (request.owner?.includes("]")) throw new PatchError("owner cannot contain a closing bracket");
  const line = `  - [ ] ${request.id} ${plain(request.title, "title")}${owner}`;
  if (!CHECKLIST_RE.test(line)) throw new PatchError("subtask cannot round-trip through the checklist parser");
  const existing = checklist(lines, block);
  const after = existing ? existing.entries.at(-1)?.line ?? existing.label : block.endLine;
  const added = existing ? [line] : ["", "- **Subtasks:**", line];
  return { inserts: [insert(lines, after, added)], replacements: [] };
}

function planToggle(lines: readonly string[], file: string, documents: readonly SourceDocument[], blocks: readonly DetailBlock[], request: Extract<AuthorOperation, { operation: "toggle.subtask" }>): LineChanges {
  if (request.id.match(SUBTASK_ID_RE)?.[1] !== request.taskId) {
    throw new PatchError("subtask ID must share its parent task ID");
  }
  const block = taskBlock(blocks, documents, file, request.taskId);
  const existing = checklist(lines, block);
  if (blocks.filter((candidate) => parseSubtasks(candidate).subtasks.some((subtask) => subtask.id === request.id)).length !== 1) {
    throw new PatchError(`${request.id} needs exactly one subtask in the planning corpus`);
  }
  const matches = existing?.entries.filter((entry) => entry.id === request.id) ?? [];
  if (matches.length !== 1) throw new PatchError(`${request.id} needs exactly one checklist line`);
  const entry = matches[0]!;
  const current = lines[entry.line - 1]!;
  const marker = entry.box === " " ? "x" : " ";
  const replacement: LineReplace = { line: entry.line, expected: current, value: current.replace(/^  - \[[ xX]\]/, `  - [${marker}]`) };
  return { inserts: [], replacements: [replacement] };
}

export function planAuthor(
  file: string,
  text: string,
  request: AuthorOperation,
  documents: readonly SourceDocument[],
  workflow: WorkflowConfig,
): string {
  if (text.includes("\r")) throw new PatchError("authoring does not support CR line endings");
  const lines = text.split("\n");
  const blocks = corpusBlocks(documents);
  const changes = request.operation === "create.story"
    ? planStory(lines, documents, blocks, request)
    : request.operation === "create.task"
      ? planTask(lines, file, documents, blocks, request, workflow)
      : request.operation === "create.subtask"
        ? planSubtask(lines, file, documents, blocks, request)
        : planToggle(lines, file, documents, blocks, request);
  const updated = applyLineChanges(text, changes);
  const originalIds = blocks.filter((block) => block.file === file).map((block) => block.id);
  const resultingIds = extractDetailBlocks(updated.split("\n"), file).map((block) => block.id);
  for (const id of new Set(originalIds)) {
    if (resultingIds.filter((candidate) => candidate === id).length !==
        originalIds.filter((candidate) => candidate === id).length) {
      throw new PatchError("authoring changed an existing detail block's identity");
    }
  }
  const projected = documents.map((document) => document.path === file ? { ...document, text: updated } : document);
  const board = buildBoard(projected, new Set(), [], new Date(0).toISOString(), workflow);
  if (request.operation === "create.story") {
    const story = board.stories.filter((candidate) => candidate.id === request.id && candidate.file === file);
    if (story.length !== 1 || story[0]!.title !== request.title ||
        story[0]!.outcome !== request.outcome || story[0]!.soThat !== request.soThat ||
        story[0]!.kind !== (request.kind ?? "story") ||
        story[0]!.role !== ((request.kind ?? "story") === "enabler" ? null : request.role ?? null) ||
        story[0]!.demo !== (request.demo ?? null)) {
      throw new PatchError("created story did not round-trip through the board model");
    }
  } else if (request.operation === "create.task") {
    const task = board.tasks.find((candidate) => candidate.id === request.id && candidate.file === file);
    const story = board.stories.find((candidate) => candidate.id === request.storyId && candidate.file === file);
    if (!task || task.title !== request.title || task.storyId !== request.storyId || !story?.taskIds.includes(request.id)) {
      throw new PatchError("created task did not join its story in the board model");
    }
  } else {
    const task = board.tasks.find((candidate) => candidate.id === request.taskId && candidate.file === file);
    const subtask = task?.subtasks.find((candidate) => candidate.id === request.id);
    const wasDone = changes.replacements[0]?.expected.match(/^  - \[([ xX])\]/)?.[1] !== " ";
    if (!subtask || (request.operation === "create.subtask" &&
        (subtask.done || subtask.title !== request.title || subtask.owner !== (request.owner ?? null))) ||
        (request.operation === "toggle.subtask" && subtask.done === wasDone)) {
      throw new PatchError("subtask did not round-trip through the board model");
    }
  }
  return updated;
}
