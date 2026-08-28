import { z } from "zod";

import { toBoardResponse } from "./board-response.ts";
import {
  commitPlanningChanges,
  defaultCommitMessage,
  GitError,
  gitHead,
  gitStatus,
  suggestedBranchName,
} from "./git.ts";
import { forgetHistory, HistoryError, lastChangedIndex, taskHistory } from "./history.ts";
import { loadBoard, planningDocuments } from "./ledger/corpus.ts";
import { NoteError, planNote } from "./ledger/notes.ts";
import { ConflictError, PatchError } from "./ledger/patch.ts";
import { applyWrite, ForbiddenPathError, ValidationError } from "./ledger/write.ts";
import type { BoardRuntime } from "./runtime.ts";

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

const shaSchema = z.string().regex(/^[a-f0-9]{64}$/i, "must be a SHA-256 digest");
const editSchema = z
  .object({
    line: z.number().int().positive(),
    column: z.number().int().nonnegative(),
    expected: z.string(),
    value: z.string(),
  })
  .strict();
const moveSchema = z
  .object({ fromLine: z.number().int().positive(), toLine: z.number().int().positive() })
  .strict();
const writeSchema = z
  .object({
    file: z.string().min(1),
    baseSha256: shaSchema,
    edits: z.array(editSchema).optional(),
    move: moveSchema.nullish(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.edits?.length ?? 0) === 0 && value.move == null) {
      context.addIssue({ code: "custom", message: "nothing to write" });
    }
  });
const noteSchema = z
  .object({
    file: z.string().min(1),
    taskId: z.string().min(1),
    baseSha256: shaSchema,
    text: z.string(),
    title: z.string().optional(),
  })
  .strict();
const commitSchema = z
  .object({
    taskIds: z.array(z.string()).default([]),
    message: z.string().optional(),
    branch: z.string().optional(),
  })
  .strict();
const historySchema = z.object({ file: z.string().min(1), task: z.string().min(1) }).strict();

function badRequest(error: z.ZodError | string): ApiResponse {
  const message = typeof error === "string"
    ? error
    : error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ");
  return { status: 400, body: { error: message } };
}

function writeFailure(error: unknown): ApiResponse {
  if (error instanceof ConflictError) {
    return { status: 409, body: { error: error.message, kind: "conflict" } };
  }
  if (error instanceof ValidationError) {
    return {
      status: 422,
      body: { error: error.message, kind: "validation", details: error.details },
    };
  }
  if (error instanceof PatchError) {
    return { status: 400, body: { error: error.message, kind: "patch" } };
  }
  if (error instanceof ForbiddenPathError) {
    return { status: 403, body: { error: error.message, kind: "forbidden" } };
  }
  throw error;
}

async function handleWrite(runtime: BoardRuntime, payload: unknown): Promise<ApiResponse> {
  const parsed = writeSchema.safeParse(payload);
  if (!parsed.success) return badRequest(parsed.error);
  try {
    const request = parsed.data;
    const result = await applyWrite(runtime, {
      file: request.file,
      baseSha256: request.baseSha256,
      edits: request.edits ?? [],
      ...(request.move == null ? {} : { move: request.move }),
    });
    forgetHistory();
    return { status: 200, body: result };
  } catch (error) {
    return writeFailure(error);
  }
}

async function handleHistory(runtime: BoardRuntime, query: URLSearchParams): Promise<ApiResponse> {
  const parsed = historySchema.safeParse({ file: query.get("file"), task: query.get("task") });
  if (!parsed.success) return badRequest(parsed.error);
  try {
    return {
      status: 200,
      body: await taskHistory(runtime, parsed.data.file, parsed.data.task),
    };
  } catch (error) {
    if (error instanceof HistoryError) {
      return { status: 400, body: { error: error.message, kind: "history" } };
    }
    throw error;
  }
}

async function handleHistorySummary(runtime: BoardRuntime): Promise<ApiResponse> {
  const documents = await planningDocuments(runtime);
  return {
    status: 200,
    body: await lastChangedIndex(runtime, documents.map((document) => document.path)),
  };
}

async function handleNote(runtime: BoardRuntime, payload: unknown): Promise<ApiResponse> {
  const parsed = noteSchema.safeParse(payload);
  if (!parsed.success) return badRequest(parsed.error);
  const { file, taskId, baseSha256, text, title } = parsed.data;
  const documents = await planningDocuments(runtime);
  const document = documents.find((candidate) => candidate.path === file);
  if (!document) return { status: 404, body: { error: `${file} is not a planning document` } };

  try {
    const plan = planNote(document.text, { taskId, text, ...(title === undefined ? {} : { title }) });
    if (plan.createsBlock) {
      const clash = documents.find(
        (candidate) =>
          candidate.path !== file &&
          new RegExp(`^#{1,6}\\s+\`?${taskId}\`?(?:\\s|$)`, "m").test(candidate.text),
      );
      if (clash) {
        return {
          status: 409,
          body: {
            error: `${taskId} already has a detail block in ${clash.path}; add the note there`,
            kind: "conflict",
          },
        };
      }
    }

    const result = await applyWrite(runtime, {
      file,
      baseSha256,
      edits: [],
      insert: plan.insert,
    });
    forgetHistory();
    return { status: 200, body: { ...result, createdBlock: plan.createsBlock } };
  } catch (error) {
    if (error instanceof NoteError) {
      return { status: 422, body: { error: error.message, kind: "note" } };
    }
    return writeFailure(error);
  }
}

async function handleCommit(runtime: BoardRuntime, payload: unknown): Promise<ApiResponse> {
  const parsed = commitSchema.safeParse(payload);
  if (!parsed.success) return badRequest(parsed.error);
  const message = parsed.data.message?.trim() || defaultCommitMessage(parsed.data.taskIds);
  try {
    const result = await commitPlanningChanges(runtime, {
      message,
      ...(parsed.data.branch ? { branch: parsed.data.branch } : {}),
    });
    forgetHistory();
    return { status: 200, body: result };
  } catch (error) {
    if (error instanceof GitError) {
      return { status: 409, body: { error: error.message, kind: "git" } };
    }
    throw error;
  }
}

export async function handleApi(
  runtime: BoardRuntime,
  method: string,
  pathname: string,
  payload: unknown,
  query: URLSearchParams = new URLSearchParams(),
): Promise<ApiResponse> {
  if (method === "GET" && pathname === "/api/session") {
    const [board, status, sourceSha] = await Promise.all([
      loadBoard(runtime),
      gitStatus(runtime),
      gitHead(runtime),
    ]);
    return {
      status: 200,
      body: {
        sourceRef: status.detached ? "HEAD" : `refs/heads/${status.branch}`,
        sourceSha,
        builtAt: board.generatedAt,
        capabilities: { history: true, liveEvents: true, localWrites: true },
      },
    };
  }
  if (method === "GET" && pathname === "/api/board") {
    return { status: 200, body: toBoardResponse(await loadBoard(runtime)) };
  }
  if (method === "GET" && pathname === "/api/history") return handleHistory(runtime, query);
  if (method === "GET" && pathname === "/api/history/summary") {
    return handleHistorySummary(runtime);
  }
  if (method === "GET" && pathname === "/api/git/status") {
    return {
      status: 200,
      body: { ...(await gitStatus(runtime)), suggestedBranch: suggestedBranchName() },
    };
  }
  if (method === "POST" && pathname === "/api/write") return handleWrite(runtime, payload);
  if (method === "POST" && pathname === "/api/note") return handleNote(runtime, payload);
  if (method === "POST" && pathname === "/api/git/commit") return handleCommit(runtime, payload);
  return { status: 404, body: { error: `no route for ${method} ${pathname}` } };
}
