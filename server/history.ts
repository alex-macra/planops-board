import { readFile, stat } from "node:fs/promises";

import type { BoardRuntime } from "./runtime.ts";
import { assertSafeRepositoryFile, discoverPlanningDocuments } from "./runtime.ts";
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
  readonly file: string;
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
    "--literal-pathspecs",
    "log",
    "--follow",
    "--find-renames",
    "--name-status",
    "-z",
    "--format=%x00%x00%x00%x00%H%x00%aI%x00%an%x00%s",
    "--",
    file,
  );
  let historicalPath = file;
  const newestFirst: Commit[] = [];
  for (const record of log.split(/\0{4,}/).filter(Boolean)) {
    const [sha, date, author, subject, ...changes] = record.split("\0");
    if (!sha || !date) continue;
    newestFirst.push({
      sha,
      date,
      author: author ?? "",
      subject: subject ?? "",
      file: historicalPath,
    });
    for (let index = 0; index < changes.length;) {
      const status = (changes[index] ?? "").replace(/^\n+/, "");
      index += 1;
      if (!status) continue;
      if (/^[RC]\d+$/.test(status)) {
        const source = changes[index] ?? "";
        const target = changes[index + 1] ?? "";
        index += 2;
        if (status.startsWith("R") && target === historicalPath) historicalPath = source;
      } else {
        index += 1;
      }
    }
  }
  return newestFirst.reverse();
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
        return await git(runtime, "show", `${commit.sha}:./${commit.file}`);
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
  writableFiles: ReadonlySet<string>,
): Promise<FileHistory> {
  if (!writableFiles.has(file)) {
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
  const writableFiles = new Set(
    await discoverPlanningDocuments(runtime.repositoryRoot, runtime.config, { allowEmpty: true }),
  );
  const history = await fileHistory(runtime, file, await headSha(runtime), writableFiles);
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

export type LastChangedByFile = Readonly<Record<string, Readonly<Record<string, LastChange>>>>;

export async function lastChangedByFile(
  runtime: BoardRuntime,
  files: readonly string[],
): Promise<LastChangedByFile> {
  const [head, discovered] = await Promise.all([
    headSha(runtime),
    discoverPlanningDocuments(runtime.repositoryRoot, runtime.config, { allowEmpty: true }),
  ]);
  const writableFiles = new Set(discovered);
  const histories = await Promise.all(
    files.map(async (file) => {
      try {
        return await fileHistory(runtime, file, head, writableFiles);
      } catch {
        return null;
      }
    }),
  );

  const byFile: Record<string, Record<string, LastChange>> = {};
  histories.forEach((history, index) => {
    if (history === null) return;
    const changes: Record<string, LastChange> = {};
    for (const [taskId, entries] of history.byTask) {
      const latest = entries[entries.length - 1];
      if (!latest) continue;
      changes[taskId] = { date: latest.date, sha: latest.sha, subject: latest.subject };
    }
    const file = files[index];
    if (file) byFile[file] = changes;
  });
  return byFile;
}

export async function lastChangedIndex(
  runtime: BoardRuntime,
  files: readonly string[],
): Promise<Record<string, LastChange>> {
  const index: Record<string, LastChange> = {};
  const byFile = await lastChangedByFile(runtime, files);
  for (const file of files) {
    Object.assign(index, byFile[file]);
  }
  return index;
}

export function forgetHistory(): void {
  cache.clear();
}
