import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
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
  readonly sourceHead: string;
  readonly worktreeDigest: string;
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

async function trustsFileMode(root: string): Promise<boolean> {
  return git(root, "config", "--bool", "core.filemode")
    .then((value) => value.trim() !== "false", () => true);
}

interface CapturedWorktreeEntry {
  readonly bytes: Uint8Array;
  readonly mode: "100644" | "100755";
}

function createWorktreeDigest(): ReturnType<typeof createHash> {
  return createHash("sha256").update("planning-worktree-v1\0");
}

function addWorktreeDigestEntry(
  hash: ReturnType<typeof createHash>,
  relativePath: string,
  entry: CapturedWorktreeEntry | null,
): void {
  hash.update("path\0").update(relativePath).update("\0");
  if (!entry) {
    hash.update("deleted\0");
    return;
  }
  hash
    .update("file\0")
    .update(entry.mode)
    .update("\0")
    .update(String(entry.bytes.byteLength))
    .update("\0")
    .update(entry.bytes);
}

async function planningWorktreeState(
  runtime: BoardRuntime,
  paths: readonly string[],
  headModes: ReadonlyMap<string, ReadonlySet<string>>,
  trustFileMode: boolean,
): Promise<string> {
  const hash = createWorktreeDigest();
  for (const relativePath of paths) {
    const previousMode = [...(headModes.get(relativePath) ?? [])][0];
    const entry = await captureEntry(runtime, relativePath, previousMode, trustFileMode);
    addWorktreeDigestEntry(hash, relativePath, entry);
  }
  return hash.digest("hex");
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
  const head = (await git(runtime.repositoryRoot, "rev-parse", "HEAD")).trim();

  const changed = new Set<string>();
  const other = new Set<string>();
  for (const filePath of changedPaths(porcelain)) {
    (writableFiles.has(filePath) ? changed : other).add(filePath);
  }
  const changedPlanningFiles = [...changed].sort();
  const otherChangedFiles = [...other].sort();
  const [indexState, headEntries, trustFileMode] = await Promise.all([
    git(runtime.repositoryRoot, "ls-files", "--stage", "-z"),
    git(runtime.repositoryRoot, "ls-tree", "-r", "-z", head),
    trustsFileMode(runtime.repositoryRoot),
  ]);
  const worktreeState = await planningWorktreeState(
    runtime,
    changedPlanningFiles,
    modesByPath(headEntries),
    trustFileMode,
  );

  const status: GitStatus = {
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
      .update("v2\0")
      .update(head)
      .update("\0branch\0")
      .update(branch)
      .update("\0included\0")
      .update(changedPlanningFiles.join("\0"))
      .update("\0excluded\0")
      .update(otherChangedFiles.join("\0"))
      .update("\0porcelain\0")
      .update(porcelain)
      .update("\0index\0")
      .update(indexState)
      .update("\0included-worktree\0")
      .update(worktreeState)
      .digest("hex"),
    sourceHead: head,
    worktreeDigest: worktreeState,
  };
  Object.defineProperties(status, {
    sourceHead: { enumerable: false },
    worktreeDigest: { enumerable: false },
  });
  return status;
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
  readonly beforeIndexPublish?: () => void | Promise<void>;
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

interface SelectedEntry {
  readonly path: string;
  readonly entry: CapturedEntry | null;
}

interface IndexEntry {
  readonly mode: string;
  readonly oid: string;
  readonly stage: string;
  readonly path: string;
}

interface CommitCandidate {
  readonly tree: string;
  readonly selectedEntries: readonly SelectedEntry[];
  readonly worktreeDigest: string;
}

interface HeldIndexLock {
  readonly indexPath: string;
  readonly lockPath: string;
  readonly device: number;
  readonly inode: number;
  handle: FileHandle | null;
  published: boolean;
}

interface PreparedIndex {
  readonly originalBytes: Uint8Array;
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

function selectedIndexInfo(
  selectedEntries: readonly SelectedEntry[],
  oidLength: number,
): string {
  const zeroOid = "0".repeat(oidLength);
  let input = "";
  for (const selected of selectedEntries) {
    input += `0 ${zeroOid}\t${selected.path}\0`;
  }
  for (const selected of selectedEntries) {
    if (selected.entry) {
      input += `${selected.entry.mode} ${selected.entry.oid}\t${selected.path}\0`;
    }
  }
  return input;
}

function indexTuple(entry: IndexEntry): string {
  return `${entry.path}\0${entry.stage}\0${entry.mode}\0${entry.oid}`;
}

function isDirectoryFileConflict(left: string, right: string): boolean {
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function assertNoExcludedDirectoryFileConflicts(
  selectedEntries: readonly SelectedEntry[],
  currentEntries: readonly IndexEntry[],
): void {
  const selectedPaths = new Set(selectedEntries.map((selected) => selected.path));
  for (const selected of selectedEntries) {
    if (!selected.entry) continue;
    const conflict = currentEntries.find((entry) =>
      !selectedPaths.has(entry.path) && isDirectoryFileConflict(selected.path, entry.path)
    );
    if (conflict) {
      throw new GitPreviewConflictError(
        `the selected file ${selected.path} conflicts with excluded staged path ${conflict.path}`,
      );
    }
  }
}

function assertExcludedEntriesUnchanged(
  selectedEntries: readonly SelectedEntry[],
  before: readonly IndexEntry[],
  after: readonly IndexEntry[],
): void {
  const selectedPaths = new Set(selectedEntries.map((selected) => selected.path));
  const excludedBefore = before
    .filter((entry) => !selectedPaths.has(entry.path))
    .map(indexTuple)
    .sort();
  const excludedAfter = after
    .filter((entry) => !selectedPaths.has(entry.path))
    .map(indexTuple)
    .sort();
  if (
    excludedBefore.length !== excludedAfter.length ||
    excludedBefore.some((entry, index) => entry !== excludedAfter[index])
  ) {
    throw new GitPreviewConflictError(
      "the selected files conflict with excluded staged changes; review the updated commit preview",
    );
  }
}

function assertSelectedEntriesApplied(
  selectedEntries: readonly SelectedEntry[],
  preparedEntries: readonly IndexEntry[],
): void {
  for (const selected of selectedEntries) {
    const entries = preparedEntries.filter((entry) => entry.path === selected.path);
    if (!selected.entry) {
      if (entries.length > 0) {
        throw new GitPreviewConflictError(
          `the prepared Git index retained selected deletion ${selected.path}`,
        );
      }
      continue;
    }
    const entry = entries[0];
    if (
      entries.length !== 1 ||
      !entry ||
      entry.stage !== "0" ||
      entry.mode !== selected.entry.mode ||
      entry.oid !== selected.entry.oid
    ) {
      throw new GitPreviewConflictError(
        `the prepared Git index does not match selected file ${selected.path}`,
      );
    }
  }
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
): Promise<CapturedWorktreeEntry | null> {
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
  const repositoryToken = createHash("sha256")
    .update(runtime.repositoryRoot)
    .digest("hex")
    .slice(0, 16);
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), `planops-board-commit-${repositoryToken}-`),
  );
  const indexFile = path.join(temporaryDirectory, "index");
  try {
    await gitCommand(runtime.repositoryRoot, ["read-tree", head], { indexFile });
    const headModes = modesByPath(await git(runtime.repositoryRoot, "ls-tree", "-r", "-z", head));
    const trustFileMode = await trustsFileMode(runtime.repositoryRoot);
    const selectedEntries: SelectedEntry[] = [];
    const worktreeHash = createWorktreeDigest();

    for (const relativePath of files) {
      const previousMode = [...(headModes.get(relativePath) ?? [])][0];
      const entry = await captureEntry(runtime, relativePath, previousMode, trustFileMode);
      addWorktreeDigestEntry(worktreeHash, relativePath, entry);
      if (!entry) {
        selectedEntries.push({ path: relativePath, entry: null });
        continue;
      }
      const oid = (await gitCommand(
        runtime.repositoryRoot,
        ["hash-object", "-w", "--path", relativePath, "--stdin"],
        { stdin: entry.bytes },
      )).trim();
      selectedEntries.push({ path: relativePath, entry: { mode: entry.mode, oid } });
    }

    await gitCommand(
      runtime.repositoryRoot,
      ["update-index", "-z", "--add", "--index-info"],
      { indexFile, stdin: selectedIndexInfo(selectedEntries, head.length) },
    );
    validatePlanningDocuments(runtime, await candidateDocuments(runtime, indexFile));
    const tree = (await gitCommand(runtime.repositoryRoot, ["write-tree"], { indexFile })).trim();
    const changed = (await git(
      runtime.repositoryRoot,
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      "-z",
      head,
      tree,
    )).split("\0").filter(Boolean);
    const selectedPaths = new Set(selectedEntries.map((selected) => selected.path));
    const unexpectedPath = changed.find((relativePath) => !selectedPaths.has(relativePath));
    if (unexpectedPath) {
      throw new GitPreviewConflictError(
        `candidate commit would change excluded path ${unexpectedPath}; review the updated commit preview`,
      );
    }
    return { tree, selectedEntries, worktreeDigest: worktreeHash.digest("hex") };
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw invalidPlanningDocuments(error);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function acquireIndexLock(runtime: BoardRuntime): Promise<HeldIndexLock> {
  const indexPath = path.join(runtime.gitDirectory, "index");
  const lockPath = `${indexPath}.lock`;
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "wx", 0o666);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new GitPreviewConflictError(
        "the Git index is locked by another operation; review the commit preview after it finishes",
      );
    }
    throw new GitError(`could not lock the Git index: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const metadata = await handle.stat();
    return {
      indexPath,
      lockPath,
      device: metadata.dev,
      inode: metadata.ino,
      handle,
      published: false,
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    let ownedIdentity: { readonly device: number; readonly inode: number } | null = null;
    try {
      const [opened, named] = await Promise.all([handle.stat(), lstat(lockPath)]);
      if (opened.dev === named.dev && opened.ino === named.ino) {
        ownedIdentity = { device: opened.dev, inode: opened.ino };
      } else {
        cleanupErrors.push(new GitPreviewConflictError(
          "ownership of the Git index lock was lost during acquisition",
        ));
      }
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    let removed = false;
    if (ownedIdentity && process.platform !== "win32") {
      try {
        const named = await lstat(lockPath);
        if (named.dev === ownedIdentity.device && named.ino === ownedIdentity.inode) {
          await unlink(lockPath);
          removed = true;
        } else {
          cleanupErrors.push(new GitPreviewConflictError(
            "ownership of the Git index lock was lost before acquisition cleanup",
          ));
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      await handle.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (ownedIdentity && !removed && process.platform === "win32") {
      try {
        const named = await lstat(lockPath);
        if (named.dev === ownedIdentity.device && named.ino === ownedIdentity.inode) {
          await unlink(lockPath);
        } else {
          cleanupErrors.push(new GitPreviewConflictError(
            "ownership of the Git index lock was lost before acquisition cleanup",
          ));
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    const inspectionError = new GitError(
      `could not inspect the Git index lock: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [inspectionError, ...cleanupErrors],
        "could not inspect or clean up the Git index lock",
      );
    }
    throw inspectionError;
  }
}

async function assertIndexLockOwned(lock: HeldIndexLock): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(lock.lockPath);
  } catch (error) {
    throw new GitPreviewConflictError(
      `ownership of the Git index lock was lost: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (metadata.dev !== lock.device || metadata.ino !== lock.inode) {
    throw new GitPreviewConflictError(
      "ownership of the Git index lock was lost; another Git operation may be running",
    );
  }
}

async function releaseIndexLock(lock: HeldIndexLock): Promise<void> {
  if (lock.published) {
    if (lock.handle) {
      try {
        await lock.handle.close();
      } catch {}
      lock.handle = null;
    }
    return;
  }
  const errors: unknown[] = [];
  let owned = false;
  try {
    await assertIndexLockOwned(lock);
    owned = true;
  } catch {}
  const handleWasOpen = lock.handle !== null;
  if (owned && handleWasOpen && process.platform !== "win32") {
    try {
      await unlink(lock.lockPath);
      owned = false;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") errors.push(error);
    }
  }
  if (lock.handle) {
    try {
      await lock.handle.close();
      lock.handle = null;
    } catch (error) {
      errors.push(error);
    }
  }
  if (owned) {
    try {
      await assertIndexLockOwned(lock);
      await unlink(lock.lockPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "could not release the Git index lock");
  }
}

async function withIndexLock<T>(
  runtime: BoardRuntime,
  operation: (lock: HeldIndexLock) => Promise<T>,
): Promise<T> {
  const lock = await acquireIndexLock(runtime);
  let result: T;
  try {
    result = await operation(lock);
  } catch (error) {
    try {
      await releaseIndexLock(lock);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Git index operation and cleanup failed");
    }
    throw error;
  }
  await releaseIndexLock(lock);
  return result;
}

async function prepareLockedIndex(
  runtime: BoardRuntime,
  lock: HeldIndexLock,
  selectedEntries: readonly SelectedEntry[],
  oidLength: number,
): Promise<PreparedIndex> {
  if (!lock.handle) throw new GitError("the Git index lock is not held");
  const temporaryDirectory = await mkdtemp(
    path.join(runtime.gitDirectory, "planops-board-index-"),
  );
  const preparedPath = path.join(temporaryDirectory, "index");
  try {
    let originalBytes: Uint8Array;
    let originalMode: number;
    try {
      const [bytes, metadata] = await Promise.all([
        readFile(lock.indexPath),
        stat(lock.indexPath),
      ]);
      originalBytes = bytes;
      originalMode = metadata.mode & 0o777;
    } catch (error) {
      throw new GitError(
        `could not read the Git index: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await writeFile(preparedPath, originalBytes, { mode: originalMode });
    const before = indexEntries(await gitCommand(
      runtime.repositoryRoot,
      ["ls-files", "--stage", "-z"],
      { indexFile: preparedPath },
    ));
    assertNoExcludedDirectoryFileConflicts(selectedEntries, before);
    await gitCommand(
      runtime.repositoryRoot,
      ["update-index", "-z", "--add", "--index-info"],
      { indexFile: preparedPath, stdin: selectedIndexInfo(selectedEntries, oidLength) },
    );
    const after = indexEntries(await gitCommand(
      runtime.repositoryRoot,
      ["ls-files", "--stage", "-z"],
      { indexFile: preparedPath },
    ));
    assertSelectedEntriesApplied(selectedEntries, after);
    assertExcludedEntriesUnchanged(selectedEntries, before, after);

    const preparedHandle = await open(preparedPath, "r+");
    try {
      await preparedHandle.sync();
    } finally {
      await preparedHandle.close();
    }
    const preparedBytes = await readFile(preparedPath);
    const currentBytes = await readFile(lock.indexPath);
    if (!Buffer.from(currentBytes).equals(Buffer.from(originalBytes))) {
      throw new GitPreviewConflictError(
        "the Git index changed while preparing the commit; review the updated commit preview",
      );
    }

    await assertIndexLockOwned(lock);
    await lock.handle.chmod(originalMode);
    await lock.handle.writeFile(preparedBytes);
    await lock.handle.sync();
    return { originalBytes };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function assertIndexUnchanged(lock: HeldIndexLock, prepared: PreparedIndex): Promise<void> {
  const currentBytes = await readFile(lock.indexPath);
  if (!Buffer.from(currentBytes).equals(Buffer.from(prepared.originalBytes))) {
    throw new GitPreviewConflictError(
      "the Git index changed while preparing the commit; review the updated commit preview",
    );
  }
}

async function resolveCommit(root: string, revision: string): Promise<string | null> {
  return git(root, "rev-parse", "--verify", `${revision}^{commit}`)
    .then((value) => value.trim(), () => null);
}

async function ensureTargetRef(
  runtime: BoardRuntime,
  targetRef: string,
  commitSha: string,
  zeroOid: string,
): Promise<boolean> {
  if (await resolveCommit(runtime.repositoryRoot, targetRef)) return true;
  const currentValue = await git(runtime.repositoryRoot, "rev-parse", "--verify", targetRef)
    .then((value) => value.trim(), () => null);
  if (currentValue !== null) return false;
  await git(runtime.repositoryRoot, "update-ref", targetRef, commitSha, zeroOid)
    .catch(() => undefined);
  return await resolveCommit(runtime.repositoryRoot, targetRef) !== null;
}

async function recoverResolvableHead(
  runtime: BoardRuntime,
  status: GitStatus,
  acceptedHead: string,
  targetRef: string,
  recoveryCommit: string,
  zeroOid: string,
): Promise<void> {
  if (await resolveCommit(runtime.repositoryRoot, "HEAD")) return;

  if (!status.detached) {
    const sourceRef = `refs/heads/${status.branch}`;
    if (await resolveCommit(runtime.repositoryRoot, sourceRef) === acceptedHead) {
      try {
        await git(runtime.repositoryRoot, "symbolic-ref", "HEAD", sourceRef);
        if (await resolveCommit(runtime.repositoryRoot, "HEAD") === acceptedHead) return;
      } catch {}
    }
  }

  if (await ensureTargetRef(runtime, targetRef, recoveryCommit, zeroOid)) {
    try {
      await git(runtime.repositoryRoot, "symbolic-ref", "HEAD", targetRef);
      if (await resolveCommit(runtime.repositoryRoot, "HEAD")) return;
    } catch {}
  }

  if (await resolveCommit(runtime.repositoryRoot, "HEAD")) return;
  await git(
    runtime.repositoryRoot,
    "update-ref",
    "--no-deref",
    "HEAD",
    recoveryCommit,
  );
  if (await resolveCommit(runtime.repositoryRoot, "HEAD") !== recoveryCommit) {
    throw new GitError("could not recover HEAD after the failed branch installation");
  }
}

const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set([
  "EINVAL",
  "EISDIR",
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
]);

async function syncGitDirectory(gitDirectory: string): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(gitDirectory, "r");
  } catch (error) {
    if (
      UNSUPPORTED_DIRECTORY_SYNC_CODES.has(errorCode(error)) ||
      (process.platform === "win32" && ["EACCES", "EPERM"].includes(errorCode(error)))
    ) {
      return;
    }
    throw error;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (!UNSUPPORTED_DIRECTORY_SYNC_CODES.has(errorCode(error))) throw error;
  } finally {
    await handle.close();
  }
}

async function installCommit(
  runtime: BoardRuntime,
  status: GitStatus,
  request: CommitRequest,
  head: string,
  commitSha: string,
  indexLock: HeldIndexLock,
  beforeIndexPublish?: () => void | Promise<void>,
): Promise<string> {
  const targetBranch = request.branch ?? status.branch;
  const targetRef = `refs/heads/${targetBranch}`;
  const zeroOid = "0".repeat(head.length);
  let refUpdated = false;
  let headUpdated = false;
  try {
    await assertIndexLockOwned(indexLock);
    if (request.branch) {
      await git(runtime.repositoryRoot, "update-ref", targetRef, commitSha, zeroOid);
      refUpdated = true;
      await git(runtime.repositoryRoot, "symbolic-ref", "HEAD", targetRef);
      headUpdated = true;
    } else {
      await git(runtime.repositoryRoot, "update-ref", targetRef, commitSha, head);
      refUpdated = true;
    }
    if (beforeIndexPublish) await beforeIndexPublish();
    await assertIndexLockOwned(indexLock);
    await rename(indexLock.lockPath, indexLock.indexPath);
    indexLock.published = true;
    if (indexLock.handle) {
      try {
        await indexLock.handle.close();
        indexLock.handle = null;
      } catch {}
    }
    await syncGitDirectory(runtime.gitDirectory);
  } catch (error) {
    if (indexLock.published) throw error;
    const rollbackErrors: unknown[] = [];
    const currentHeadRef = request.branch
      ? await git(runtime.repositoryRoot, "rev-parse", "--symbolic-full-name", "HEAD")
        .then((value) => value.trim(), () => null)
      : null;
    const currentHeadCommit = request.branch
      ? await resolveCommit(runtime.repositoryRoot, "HEAD")
      : null;
    const preserveTarget = request.branch !== undefined &&
      (
        headUpdated ||
        currentHeadRef === null ||
        currentHeadRef === targetRef ||
        currentHeadCommit === null
      );
    if (refUpdated) {
      try {
        if (request.branch) {
          if (preserveTarget) {
            rollbackErrors.push(new GitError(
              `did not delete ${targetBranch} because HEAD may depend on it`,
            ));
          } else {
            await git(runtime.repositoryRoot, "update-ref", "-d", targetRef, commitSha);
          }
        } else {
          await git(runtime.repositoryRoot, "update-ref", targetRef, head, commitSha);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    try {
      await recoverResolvableHead(
        runtime,
        status,
        head,
        targetRef,
        request.branch ? commitSha : head,
        zeroOid,
      );
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "commit installation and rollback failed",
      );
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

    const head = status.sourceHead;
    const candidate = await buildCommitCandidate(runtime, head, status.changedPlanningFiles);
    if (candidate.worktreeDigest !== status.worktreeDigest) {
      throw new GitPreviewConflictError(
        "working tree changed while capturing the commit; review the updated commit preview",
      );
    }
    const headTree = (await git(runtime.repositoryRoot, "rev-parse", `${head}^{tree}`)).trim();
    if (candidate.tree === headTree) {
      throw new GitError("no planning document changes to commit");
    }
    return await withIndexLock(runtime, async (indexLock) => {
      await assertNoGitOperation(runtime);
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
      const prepared = await prepareLockedIndex(
        runtime,
        indexLock,
        candidate.selectedEntries,
        head.length,
      );
      const finalFiles = await planningGitAllowlist(runtime);
      const finalStatus = await gitStatus(
        runtime,
        new Set([...allowedFiles].filter((file) => finalFiles.has(file))),
      );
      if (request.expectedCommitPreviewToken !== finalStatus.commitPreviewToken) {
        throw new GitPreviewConflictError(
          "working tree changed; review the updated commit preview",
        );
      }
      await assertNoGitOperation(runtime);
      await assertIndexUnchanged(indexLock, prepared);
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
        finalStatus,
        request,
        head,
        sha,
        indexLock,
        options.beforeIndexPublish,
      );

      return {
        branch,
        sha,
        files: status.changedPlanningFiles,
      };
    });
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
