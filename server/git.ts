import { createHash } from "node:crypto";

import { runGitCommand } from "./git-command.ts";
import { acquireLedgerLock, type LockOptions } from "./ledger/lock.ts";
import { validateRuntime } from "./ledger/write.ts";
import type { BoardRuntime } from "./runtime.ts";

export class GitError extends Error {
  override readonly name = "GitError";
}

export interface GitStatus {
  readonly branch: string;
  readonly detached: boolean;
  readonly onProtectedBranch: boolean;
  readonly changedPlanningFiles: readonly string[];
  readonly otherChangedFiles: readonly string[];
  readonly fingerprint: string;
}

async function git(root: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await runGitCommand(root, args);
    return stdout;
  } catch (error) {
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error
        ? String((error as { stderr: unknown }).stderr)
        : String(error);
    throw new GitError(stderr.trim() || `git ${args[0]} failed`);
  }
}

function changedPaths(porcelain: string): string[] {
  const records = porcelain.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    paths.push(record.slice(3));
    if (status.includes("R") || status.includes("C")) {
      const source = records[index + 1];
      if (source) paths.push(source);
      index += 1;
    }
  }
  return paths;
}

export async function gitStatus(runtime: BoardRuntime): Promise<GitStatus> {
  const branch = (await git(runtime.repositoryRoot, "rev-parse", "--abbrev-ref", "HEAD")).trim();
  const detached = branch === "HEAD";
  const porcelain = await git(
    runtime.repositoryRoot,
    "--no-optional-locks",
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  );

  const changed = new Set<string>();
  const other = new Set<string>();
  for (const filePath of changedPaths(porcelain)) {
    (runtime.writableFiles.has(filePath) ? changed : other).add(filePath);
  }
  const changedPlanningFiles = [...changed].sort();
  const otherChangedFiles = [...other].sort();

  return {
    branch,
    detached,
    onProtectedBranch: runtime.config.git.protectedBranches.includes(branch),
    changedPlanningFiles,
    otherChangedFiles,
    fingerprint: createHash("sha256")
      .update(`${branch}\n${changedPlanningFiles.join("\n")}`)
      .digest("hex"),
  };
}

export async function gitHead(runtime: BoardRuntime): Promise<string> {
  return (await git(runtime.repositoryRoot, "rev-parse", "HEAD")).trim();
}

export async function gitFingerprint(runtime: BoardRuntime): Promise<string> {
  try {
    return (await gitStatus(runtime)).fingerprint;
  } catch {
    return "";
  }
}

export interface CommitRequest {
  readonly message: string;
  readonly branch?: string;
}

export interface CommitResult {
  readonly branch: string;
  readonly sha: string;
  readonly files: readonly string[];
}

export interface CommitOptions {
  readonly lock?: LockOptions;
}

export function suggestedBranchName(date = new Date()): string {
  return `plan/board-${date.toISOString().slice(0, 10)}`;
}

async function validateBranch(root: string, branch: string): Promise<void> {
  if (!branch.trim() || branch !== branch.trim()) throw new GitError("invalid branch name");
  await git(root, "check-ref-format", "--branch", branch);
}

export async function commitPlanningChanges(
  runtime: BoardRuntime,
  request: CommitRequest,
  options: CommitOptions = {},
): Promise<CommitResult> {
  if (!runtime.config.git.commitEnabled) throw new GitError("commits are disabled by board config");
  if (!request.message.trim()) throw new GitError("a commit message is required");

  const lock = await acquireLedgerLock(runtime.repositoryRoot, options.lock ?? {}).catch(
    (error: unknown) => {
      throw new GitError(error instanceof Error ? error.message : String(error));
    },
  );

  try {
    try {
      await validateRuntime(runtime);
    } catch (error) {
      const details =
        typeof error === "object" && error !== null && "details" in error
          ? String((error as { details: unknown }).details)
          : error instanceof Error
            ? error.message
            : String(error);
      throw new GitError(`refusing to commit invalid planning documents: ${details.slice(0, 4096)}`);
    }

    const status = await gitStatus(runtime);
    if (status.changedPlanningFiles.length === 0) {
      throw new GitError("no planning document changes to commit");
    }
    if (status.detached && !request.branch) {
      throw new GitError("refusing to commit from detached HEAD; supply a branch name first");
    }
    if (status.onProtectedBranch && !request.branch) {
      throw new GitError(
        `refusing to commit on ${status.branch}; supply a branch name to create one first`,
      );
    }

    if (request.branch) {
      await validateBranch(runtime.repositoryRoot, request.branch);
      if (runtime.config.git.protectedBranches.includes(request.branch)) {
        throw new GitError(`refusing to create the protected branch ${request.branch}`);
      }
      await git(runtime.repositoryRoot, "checkout", "-b", request.branch);
    }

    await git(runtime.repositoryRoot, "add", "--", ...status.changedPlanningFiles);
    await git(
      runtime.repositoryRoot,
      "commit",
      "--only",
      "--message",
      request.message,
      "--",
      ...status.changedPlanningFiles,
    );

    return {
      branch: (await git(runtime.repositoryRoot, "rev-parse", "--abbrev-ref", "HEAD")).trim(),
      sha: (await git(runtime.repositoryRoot, "rev-parse", "HEAD")).trim(),
      files: status.changedPlanningFiles,
    };
  } finally {
    await lock.release();
  }
}

export function defaultCommitMessage(taskIds: readonly string[]): string {
  const unique = [...new Set(taskIds)].sort();
  if (unique.length === 0) return "Update planning ledgers from the board";
  if (unique.length <= 4) return `Update ${unique.join(", ")} from the planning board`;
  return `Update ${unique.length} ledger rows from the planning board`;
}
