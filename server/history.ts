import { readFile, stat } from "node:fs/promises";

import type { BoardRuntime } from "./runtime.ts";
import { assertSafeRepositoryFile } from "./runtime.ts";
import { runGitCommand } from "./git-command.ts";
import { rowValues, type RowValues } from "./ledger/model.ts";

export class HistoryError extends Error {
  override readonly name = "HistoryError";
}

export interface HistoryEntry {
  readonly sha: string | null;
  readonly date: string;
  readonly author: string | null;
  readonly subject: string | null;
  readonly status: string | null;
  readonly priority: string | null;
  readonly changed: readonly ("status" | "priority")[];
}

export interface TaskHistory {
  readonly file: string;
  readonly taskId: string;
  readonly entries: readonly HistoryEntry[];
  readonly commitsScanned: number;
}

interface Commit {
  readonly sha: string;
  readonly date: string;
  readonly author: string;
  readonly subject: string;
}

interface FileHistory {
  readonly head: string;
  readonly mtimeMs: number;
  readonly byTask: Map<string, HistoryEntry[]>;
  readonly commitsScanned: number;
}

const cache = new Map<string, FileHistory>();

async function git(runtime: BoardRuntime, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await runGitCommand(runtime.repositoryRoot, args, {
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error
        ? String((error as { stderr: unknown }).stderr)
        : String(error);
    throw new HistoryError(stderr.trim() || `git ${args[0]} failed`);
  }
}

async function headSha(runtime: BoardRuntime): Promise<string> {
  try {
    return (await git(runtime, "rev-parse", "HEAD")).trim();
  } catch {
    return "";
  }
}

async function commitsTouching(runtime: BoardRuntime, file: string): Promise<Commit[]> {
  const log = await git(
    runtime,
    "log",
    "--follow",
    "--reverse",
    "--format=%H%x00%aI%x00%an%x00%s",
    "--",
    file,
  );
  return log
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, date, author, subject] = line.split("\0");
      return { sha: sha!, date: date!, author: author ?? "", subject: subject ?? "" };
    });
}

function changedFields(previous: RowValues | null, next: RowValues): ("status" | "priority")[] {
  const changed: ("status" | "priority")[] = [];
  if (previous === null || previous.status !== next.status) changed.push("status");
  if (previous !== null && previous.priority !== next.priority) changed.push("priority");
  return changed;
}

async function computeFile(
  runtime: BoardRuntime,
  file: string,
  head: string,
): Promise<FileHistory> {
  const commits = await commitsTouching(runtime, file);
  const byTask = new Map<string, HistoryEntry[]>();
  const previous = new Map<string, RowValues>();

  const revisions = await Promise.all(
    commits.map(async (commit) => {
      try {
        return await git(runtime, "show", `${commit.sha}:${file}`);
      } catch {
        return null;
      }
    }),
  );

  function absorb(text: string, commit: Commit | null, date: string): void {
    for (const [taskId, values] of rowValues(text)) {
      const changed = changedFields(previous.get(taskId) ?? null, values);
      if (changed.length === 0) continue;
      previous.set(taskId, values);
      const list = byTask.get(taskId) ?? [];
      list.push({
        sha: commit?.sha ?? null,
        date,
        author: commit?.author ?? null,
        subject: commit?.subject ?? null,
        status: values.status,
        priority: values.priority,
        changed,
      });
      byTask.set(taskId, list);
    }
  }

  commits.forEach((commit, index) => {
    const text = revisions[index];
    if (text !== null && text !== undefined) absorb(text, commit, commit.date);
  });

  const absolutePath = await assertSafeRepositoryFile(runtime.repositoryRoot, file);
  const [text, stats] = await Promise.all([
    readFile(absolutePath, "utf8"),
    stat(absolutePath),
  ]);
  absorb(text, null, new Date(stats.mtimeMs).toISOString());

  return { head, mtimeMs: stats.mtimeMs, byTask, commitsScanned: commits.length };
}

async function fileHistory(
  runtime: BoardRuntime,
  file: string,
  head: string,
): Promise<FileHistory> {
  if (!runtime.writableFiles.has(file)) {
    throw new HistoryError(`${file} is not a planning document`);
  }
  const key = `${runtime.repositoryRoot}\u0000${file}`;
  const absolutePath = await assertSafeRepositoryFile(runtime.repositoryRoot, file);
  const stats = await stat(absolutePath);
  const cached = cache.get(key);
  if (cached && cached.head === head && cached.mtimeMs === stats.mtimeMs) return cached;

  const computed = await computeFile(runtime, file, head);
  cache.set(key, computed);
  return computed;
}

export async function taskHistory(
  runtime: BoardRuntime,
  file: string,
  taskId: string,
): Promise<TaskHistory> {
  const history = await fileHistory(runtime, file, await headSha(runtime));
  return {
    file,
    taskId,
    entries: history.byTask.get(taskId) ?? [],
    commitsScanned: history.commitsScanned,
  };
}

export interface LastChange {
  readonly date: string;
  readonly sha: string | null;
  readonly subject: string | null;
}

export async function lastChangedIndex(
  runtime: BoardRuntime,
  files: readonly string[],
): Promise<Record<string, LastChange>> {
  const head = await headSha(runtime);
  const histories = await Promise.all(
    files.map(async (file) => {
      try {
        return await fileHistory(runtime, file, head);
      } catch {
        return null;
      }
    }),
  );

  const index: Record<string, LastChange> = {};
  for (const history of histories) {
    if (history === null) continue;
    for (const [taskId, entries] of history.byTask) {
      const latest = entries[entries.length - 1];
      if (!latest) continue;
      index[taskId] = { date: latest.date, sha: latest.sha, subject: latest.subject };
    }
  }
  return index;
}

export function forgetHistory(): void {
  cache.clear();
}
