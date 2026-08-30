import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runGitCommand, type GitCommandOptions } from "./git-command.ts";
import { sha256 } from "./ledger/corpus.ts";
import { acquireLedgerLock, type LockOptions } from "./ledger/lock.ts";
import type { SourceDocument } from "./ledger/model.ts";
import { validatePlanningDocuments } from "./ledger/validate.ts";
import { validateRuntime } from "./ledger/write.ts";
import {
  assertSafeRepositoryFile,
  assertSafeRepositoryDirectory,
  discoverPlanningDocuments,
  matchesPlanningDocumentPath,
  resolveWithin,
  type BoardRuntime,
} from "./runtime.ts";

export class GitError extends Error {
  override readonly name = "GitError";
}

export class GitPreviewConflictError extends GitError {}

export interface GitStatus {
  readonly branch: string;
  readonly detached: boolean;
  readonly onProtectedBranch: boolean;
  readonly commitEnabled: boolean;
  readonly changedPlanningFiles: readonly string[];
  readonly otherChangedFiles: readonly string[];
  readonly fingerprint: string;
  readonly commitPreviewToken: string;
}

async function gitCommand(
  root: string,
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<string> {
  try {
    const { stdout } = await runGitCommand(root, args, options);
    return stdout;
  } catch (error) {
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error
        ? String((error as { stderr: unknown }).stderr)
        : String(error);
    throw new GitError(stderr.trim() || `git ${args[0]} failed`);
  }
}

async function git(root: string, ...args: string[]): Promise<string> {
  return gitCommand(root, args);
}

function modesByPath(output: string): Map<string, Set<string>> {
  const entries = new Map<string, Set<string>>();
  for (const record of output.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const [mode] = record.slice(0, tab).split(" ");
    const relativePath = record.slice(tab + 1);
    if (!mode || !relativePath) continue;
    const modes = entries.get(relativePath) ?? new Set<string>();
    modes.add(mode);
    entries.set(relativePath, modes);
  }
  return entries;
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

export async function planningGitAllowlist(
  runtime: BoardRuntime,
  currentFiles?: ReadonlySet<string>,
): Promise<ReadonlySet<string>> {
  const allowed = new Set(currentFiles ?? await discoverPlanningDocuments(
    runtime.repositoryRoot,
    runtime.config,
    { allowEmpty: true },
  ));
  const [indexEntries, headEntries] = await Promise.all([
    git(runtime.repositoryRoot, "ls-files", "--cached", "--stage", "-z"),
    git(runtime.repositoryRoot, "ls-tree", "-r", "-z", "HEAD"),
  ]);
  const indexModes = modesByPath(indexEntries);
  const headModes = modesByPath(headEntries);
  const candidates = new Set([...indexModes.keys(), ...headModes.keys()]);
  for (const relativePath of candidates) {
    if (!matchesPlanningDocumentPath(relativePath, runtime.config) || allowed.has(relativePath)) {
      continue;
    }
    const modes = new Set([
      ...(indexModes.get(relativePath) ?? []),
      ...(headModes.get(relativePath) ?? []),
    ]);
    if (![...modes].every((mode) => mode === "100644" || mode === "100755")) continue;
    const absolute = resolveWithin(runtime.repositoryRoot, relativePath);
    try {
      await lstat(absolute);
      continue;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
      if (code !== "ENOENT") continue;
    }
    let parent = path.posix.dirname(relativePath);
    let safe = false;
    while (true) {
      const relativeParent = parent === "." ? "" : parent;
      try {
        await assertSafeRepositoryDirectory(runtime.repositoryRoot, relativeParent);
        safe = true;
        break;
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? String((error as { code: unknown }).code)
          : "";
        if (code !== "ENOENT" || relativeParent === "") break;
        const next = path.posix.dirname(relativeParent);
        parent = next === "." ? "" : next;
      }
    }
    if (safe) allowed.add(relativePath);
  }
  return allowed;
}

export async function gitStatus(
  runtime: BoardRuntime,
  allowedFiles?: ReadonlySet<string>,
): Promise<GitStatus> {
  const writableFiles = allowedFiles ?? await planningGitAllowlist(runtime);
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
  const head = await git(runtime.repositoryRoot, "rev-parse", "HEAD");

  const changed = new Set<string>();
  const other = new Set<string>();
  for (const filePath of changedPaths(porcelain)) {
    (writableFiles.has(filePath) ? changed : other).add(filePath);
  }
  const changedPlanningFiles = [...changed].sort();
  const otherChangedFiles = [...other].sort();

  return {
    branch,
    detached,
    onProtectedBranch: runtime.config.git.protectedBranches.includes(branch),
    commitEnabled: runtime.config.git.commitEnabled,
    changedPlanningFiles,
    otherChangedFiles,
    fingerprint: createHash("sha256")
      .update(`${branch}\n${changedPlanningFiles.join("\n")}`)
      .digest("hex"),
    commitPreviewToken: createHash("sha256")
      .update("v1\0")
      .update(head.trim())
      .update("\0branch\0")
      .update(branch)
      .update("\0included\0")
      .update(changedPlanningFiles.join("\0"))
      .update("\0excluded\0")
      .update(otherChangedFiles.join("\0"))
      .update("\0porcelain\0")
      .update(porcelain)
      .digest("hex"),
  };
}

export async function gitHead(runtime: BoardRuntime): Promise<string> {
  return (await git(runtime.repositoryRoot, "rev-parse", "HEAD")).trim();
}

export async function gitFingerprint(
  runtime: BoardRuntime,
  allowedFiles?: ReadonlySet<string>,
): Promise<string> {
  try {
    return (await gitStatus(runtime, allowedFiles)).fingerprint;
  } catch {
    return "";
  }
}

export interface CommitRequest {
  readonly message: string;
  readonly expectedCommitPreviewToken: string;
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

const ACTIVE_GIT_OPERATION_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
] as const;

async function assertNoGitOperation(runtime: BoardRuntime): Promise<void> {
  const unmerged = await git(runtime.repositoryRoot, "ls-files", "--unmerged", "-z");
  if (unmerged) throw new GitError("refusing to commit while the Git index has conflicts");
  for (const marker of ACTIVE_GIT_OPERATION_MARKERS) {
    try {
      await lstat(path.join(runtime.gitDirectory, marker));
      throw new GitError(`refusing to commit while a Git operation is in progress (${marker})`);
    } catch (error) {
      if (error instanceof GitError) throw error;
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

interface CapturedEntry {
  readonly mode: "100644" | "100755";
  readonly oid: string;
}

interface IndexEntry {
  readonly mode: string;
  readonly oid: string;
  readonly stage: string;
  readonly path: string;
}

interface CommitCandidate {
  readonly tree: string;
  readonly indexInfo: string;
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
}

function indexEntries(output: string): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const record of output.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const [mode, oid, stage] = record.slice(0, tab).split(" ");
    const relativePath = record.slice(tab + 1);
    if (!mode || !oid || !stage || !relativePath) continue;
    entries.push({ mode, oid, stage, path: relativePath });
  }
  return entries;
}

function invalidPlanningDocuments(error: unknown): GitError {
  const details =
    typeof error === "object" && error !== null && "details" in error
      ? String((error as { details: unknown }).details)
      : error instanceof Error
        ? error.message
        : String(error);
  return new GitError(`refusing to commit invalid planning documents: ${details.slice(0, 4096)}`);
}

async function captureEntry(
  runtime: BoardRuntime,
  relativePath: string,
  previousMode: string | undefined,
  trustFileMode: boolean,
): Promise<{ readonly bytes: Uint8Array; readonly mode: "100644" | "100755" } | null> {
  const absolutePath = resolveWithin(runtime.repositoryRoot, relativePath);
  try {
    const named = await lstat(absolutePath);
    if (!named.isFile() || named.isSymbolicLink()) {
      throw new GitPreviewConflictError(
        `working tree changed at ${relativePath}; review the updated commit preview`,
      );
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }

  await assertSafeRepositoryFile(runtime.repositoryRoot, relativePath);
  let handle;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new GitPreviewConflictError(
        `working tree changed at ${relativePath}; review the updated commit preview`,
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const [current, canonical] = await Promise.all([lstat(absolutePath), realpath(absolutePath)]);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      canonical !== absolutePath ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      after.dev !== current.dev ||
      after.ino !== current.ino ||
      after.size !== bytes.byteLength
    ) {
      throw new GitPreviewConflictError(
        `working tree changed at ${relativePath}; review the updated commit preview`,
      );
    }
    const filesystemMode = (after.mode & 0o111) === 0 ? "100644" : "100755";
    const mode = !trustFileMode && (previousMode === "100644" || previousMode === "100755")
      ? previousMode
      : filesystemMode;
    return { bytes, mode };
  } catch (error) {
    if (error instanceof GitPreviewConflictError) throw error;
    throw new GitPreviewConflictError(
      `working tree changed at ${relativePath}; review the updated commit preview`,
    );
  } finally {
    await handle?.close();
  }
}

async function candidateDocuments(
  runtime: BoardRuntime,
  indexFile: string,
): Promise<SourceDocument[]> {
  const output = await gitCommand(
    runtime.repositoryRoot,
    ["ls-files", "--stage", "-z"],
    { indexFile },
  );
  const matching = indexEntries(output).filter((entry) =>
    matchesPlanningDocumentPath(entry.path, runtime.config)
  );
  const byPath = new Map<string, IndexEntry[]>();
  for (const entry of matching) {
    const entries = byPath.get(entry.path) ?? [];
    entries.push(entry);
    byPath.set(entry.path, entries);
  }

  const documents: SourceDocument[] = [];
  for (const [relativePath, entries] of [...byPath.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const entry = entries[0];
    if (
      entries.length !== 1 ||
      !entry ||
      entry.stage !== "0" ||
      (entry.mode !== "100644" && entry.mode !== "100755")
    ) {
      throw new GitError(`refusing unsafe candidate index entry for ${relativePath}`);
    }
    const text = await git(runtime.repositoryRoot, "cat-file", "blob", entry.oid);
    documents.push({ path: relativePath, text, sha256: sha256(text) });
  }
  return documents;
}

async function buildCommitCandidate(
  runtime: BoardRuntime,
  head: string,
  files: readonly string[],
): Promise<CommitCandidate> {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "planops-board-commit-"));
  const indexFile = path.join(temporaryDirectory, "index");
  try {
    await gitCommand(runtime.repositoryRoot, ["read-tree", head], { indexFile });
    const headModes = modesByPath(await git(runtime.repositoryRoot, "ls-tree", "-r", "-z", head));
    const trustFileMode = await git(runtime.repositoryRoot, "config", "--bool", "core.filemode")
      .then((value) => value.trim() !== "false", () => true);
    const captured = new Map<string, CapturedEntry>();

    for (const relativePath of files) {
      const previousMode = [...(headModes.get(relativePath) ?? [])][0];
      const entry = await captureEntry(runtime, relativePath, previousMode, trustFileMode);
      if (!entry) continue;
      const oid = (await gitCommand(
        runtime.repositoryRoot,
        ["hash-object", "-w", "--path", relativePath, "--stdin"],
        { stdin: entry.bytes },
      )).trim();
      captured.set(relativePath, { mode: entry.mode, oid });
    }

    const zeroOid = "0".repeat(head.length);
    let indexInfo = "";
    for (const relativePath of files) {
      indexInfo += `0 ${zeroOid}\t${relativePath}\0`;
      const entry = captured.get(relativePath);
      if (entry) indexInfo += `${entry.mode} ${entry.oid}\t${relativePath}\0`;
    }
    await gitCommand(
      runtime.repositoryRoot,
      ["update-index", "-z", "--add", "--index-info"],
      { indexFile, stdin: indexInfo },
    );
    validatePlanningDocuments(runtime, await candidateDocuments(runtime, indexFile));
    const tree = (await gitCommand(runtime.repositoryRoot, ["write-tree"], { indexFile })).trim();
    return { tree, indexInfo };
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw invalidPlanningDocuments(error);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function installCommit(
  runtime: BoardRuntime,
  status: GitStatus,
  request: CommitRequest,
  head: string,
  commitSha: string,
  indexInfo: string,
): Promise<string> {
  const targetBranch = request.branch ?? status.branch;
  const targetRef = `refs/heads/${targetBranch}`;
  const zeroOid = "0".repeat(head.length);

  if (request.branch) {
    await git(runtime.repositoryRoot, "update-ref", targetRef, commitSha, zeroOid);
    try {
      await git(runtime.repositoryRoot, "symbolic-ref", "HEAD", targetRef);
    } catch (error) {
      await git(runtime.repositoryRoot, "update-ref", "-d", targetRef, commitSha).catch(() => undefined);
      throw error;
    }
  } else {
    await git(runtime.repositoryRoot, "update-ref", targetRef, commitSha, head);
  }

  try {
    await gitCommand(
      runtime.repositoryRoot,
      ["update-index", "-z", "--add", "--index-info"],
      { stdin: indexInfo },
    );
  } catch (error) {
    const rollback: unknown[] = [];
    try {
      if (request.branch) {
        if (status.detached) {
          await git(runtime.repositoryRoot, "update-ref", "--no-deref", "HEAD", head);
        } else {
          await git(runtime.repositoryRoot, "symbolic-ref", "HEAD", `refs/heads/${status.branch}`);
        }
        await git(runtime.repositoryRoot, "update-ref", "-d", targetRef, commitSha);
      } else {
        await git(runtime.repositoryRoot, "update-ref", targetRef, head, commitSha);
      }
    } catch (rollbackError) {
      rollback.push(rollbackError);
    }
    if (rollback.length > 0) {
      throw new AggregateError([error, ...rollback], "commit installation and rollback failed");
    }
    throw error;
  }
  return targetBranch;
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
    await assertNoGitOperation(runtime);
    let allowedFiles: ReadonlySet<string>;
    try {
      allowedFiles = await planningGitAllowlist(runtime);
      await validateRuntime(runtime);
    } catch (error) {
      throw invalidPlanningDocuments(error);
    }

    const presentFiles = await planningGitAllowlist(runtime);
    const status = await gitStatus(
      runtime,
      new Set([...allowedFiles].filter((file) => presentFiles.has(file))),
    );
    if (request.expectedCommitPreviewToken !== status.commitPreviewToken) {
      throw new GitPreviewConflictError(
        "working tree changed; review the updated commit preview",
      );
    }
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
    }

    const head = await gitHead(runtime);
    const candidate = await buildCommitCandidate(runtime, head, status.changedPlanningFiles);
    const headTree = (await git(runtime.repositoryRoot, "rev-parse", `${head}^{tree}`)).trim();
    if (candidate.tree === headTree) {
      throw new GitError("no planning document changes to commit");
    }
    const latestFiles = await planningGitAllowlist(runtime);
    const latestStatus = await gitStatus(
      runtime,
      new Set([...allowedFiles].filter((file) => latestFiles.has(file))),
    );
    if (request.expectedCommitPreviewToken !== latestStatus.commitPreviewToken) {
      throw new GitPreviewConflictError(
        "working tree changed; review the updated commit preview",
      );
    }
    await assertNoGitOperation(runtime);
    const sha = (await git(
      runtime.repositoryRoot,
      "commit-tree",
      candidate.tree,
      "-p",
      head,
      "-m",
      request.message,
    )).trim();
    const branch = await installCommit(
      runtime,
      status,
      request,
      head,
      sha,
      candidate.indexInfo,
    );

    return {
      branch,
      sha,
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
