import { z, type ZodType } from "zod";

import {
  apiFailureSchema,
  boardSchema,
  commitResultSchema,
  gitStatusSchema,
  lastChangedSchema,
  sessionSchema,
  taskHistorySchema,
  writeResultSchema,
  type ApiFailure,
  type Board,
  type BoardSession,
  type CellRef,
  type DetailBlock,
  type GitStatusResponse,
  type Task,
} from "../shared/contracts.ts";

export type {
  ApiFailure,
  Board,
  BoardSession,
  CellRef,
  CorpusState,
  DataQualityIssue,
  Dependency,
  DetailBlock,
  DetailField,
  DetailLink,
  Finding,
  GitStatusResponse,
  HistoryEntry,
  LastChange,
  ParkedState,
  ProjectSummary,
  Readiness,
  Story,
  StoryKind,
  Task,
  TaskHistory,
  Workflow,
} from "../shared/contracts.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly failure: ApiFailure,
  ) {
    super(failure.error);
    this.name = "ApiError";
  }
}

function failureOf(payload: unknown, fallback: string): ApiFailure {
  const parsed = apiFailureSchema.safeParse(payload);
  return parsed.success ? parsed.data : { error: fallback || "Request failed" };
}

async function request<T>(path: string, schema: ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body
      ? { "content-type": "application/json", ...init.headers }
      : init?.headers,
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, failureOf(payload, response.statusText));
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError(502, {
      error: `The server returned an invalid response for ${path}`,
      details: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n"),
    });
  }
  return parsed.data;
}

export function fetchSession(): Promise<BoardSession> {
  return request("/api/session", sessionSchema);
}

export interface BoardFetchResult {
  readonly board: Board | null;
  readonly sourceSha: string | null;
}

export async function fetchBoard(revision?: string): Promise<BoardFetchResult> {
  const response = await fetch("/api/board", {
    headers: revision ? { "if-none-match": `"${revision}"` } : undefined,
  });
  if (response.status === 304) {
    return { board: null, sourceSha: response.headers.get("x-board-source-sha") };
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, failureOf(payload, response.statusText));
  const parsed = boardSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError(502, {
      error: "The server returned an invalid board",
      details: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n"),
    });
  }
  return { board: parsed.data, sourceSha: response.headers.get("x-board-source-sha") };
}

export function fetchGitStatus(): Promise<GitStatusResponse> {
  return request("/api/git/status", gitStatusSchema);
}

export interface WriteCell {
  readonly cell: CellRef;
  readonly expected: string;
  readonly value: string;
}

export function writeCell(
  file: string,
  baseSha256: string,
  edits: readonly WriteCell[],
): Promise<{ readonly file: string; readonly sha256: string }> {
  return request("/api/write", writeResultSchema, {
    method: "POST",
    body: JSON.stringify({
      file,
      baseSha256,
      edits: edits.map((edit) => ({
        line: edit.cell.line,
        column: edit.cell.column,
        expected: edit.expected,
        value: edit.value,
      })),
    }),
  });
}

export function moveRow(
  file: string,
  baseSha256: string,
  fromLine: number,
  toLine: number,
): Promise<{ readonly file: string; readonly sha256: string }> {
  return request("/api/write", writeResultSchema, {
    method: "POST",
    body: JSON.stringify({ file, baseSha256, move: { fromLine, toLine } }),
  });
}

export function fetchTaskHistory(file: string, taskId: string) {
  const query = new URLSearchParams({ file, task: taskId });
  return request(`/api/history?${query.toString()}`, taskHistorySchema);
}

export function fetchLastChanged() {
  return request("/api/history/summary", lastChangedSchema);
}

export function addNote(payload: {
  readonly file: string;
  readonly taskId: string;
  readonly baseSha256: string;
  readonly text: string;
  readonly title?: string;
}): Promise<{ readonly file: string; readonly sha256: string; readonly createdBlock: boolean }> {
  const schema = z.object({ file: z.string(), sha256: z.string(), createdBlock: z.boolean() }).readonly();
  return request("/api/note", schema, { method: "POST", body: JSON.stringify(payload) });
}

export function detailOf(board: Board, taskId: string): DetailBlock | null {
  return board.details.find((block) => block.id === taskId) ?? null;
}

export function notesOf(block: DetailBlock) {
  return block.fields.filter((field) => field.label === "Note");
}

export function commit(payload: {
  readonly taskIds: readonly string[];
  readonly message?: string;
  readonly branch?: string;
}) {
  return request("/api/git/commit", commitResultSchema, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function documentShaOf(board: Board, file: string): string {
  const document = board.documents.find((candidate) => candidate.path === file);
  if (!document) throw new Error(`unknown document ${file}`);
  return document.sha256;
}

export function vocabularyOf(board: Board, task: Task): readonly string[] {
  return board.documents.find((document) => document.path === task.file)?.vocabulary.bases ?? [];
}
