import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { sanitizedGitEnvironment } from "../git-command.ts";
import type { BoardRuntime } from "../runtime.ts";
import { assertSafeRepositoryFile } from "../runtime.ts";
import { sha256 } from "./corpus.ts";
import { acquireLedgerLock, type LockOptions } from "./lock.ts";
import {
  ConflictError,
  insertLines,
  moveRow,
  patchCells,
  type CellEdit,
  type LineInsert,
  type RowMove,
} from "./patch.ts";
import { StructuralValidationError, validateBoardRuntime } from "./validate.ts";

const run = promisify(execFile);
const EXTERNAL_TIMEOUT_MS = 30_000;
const EXTERNAL_OUTPUT_BYTES = 1024 * 1024;

export class ValidationError extends Error {
  override readonly name = "ValidationError";
  readonly details: string;

  constructor(details: string) {
    super("the edit failed validation and was rolled back");
    this.details = details;
  }
}

export class ForbiddenPathError extends Error {
  override readonly name = "ForbiddenPathError";
}

export interface WriteRequest {
  readonly file: string;
  readonly baseSha256: string;
  readonly edits?: readonly CellEdit[];
  readonly move?: RowMove;
  readonly insert?: LineInsert;
}

export interface WriteResult {
  readonly file: string;
  readonly sha256: string;
}

export interface WriteOptions {
  readonly lock?: LockOptions;
}

const queues = new Map<string, Promise<unknown>>();

function exclusive<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(root) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const settled = result.catch(() => undefined);
  queues.set(root, settled);
  void settled.finally(() => {
    if (queues.get(root) === settled) queues.delete(root);
  });
  return result;
}

export async function validateRuntime(runtime: BoardRuntime): Promise<void> {
  try {
    await validateBoardRuntime(runtime);
  } catch (error) {
    if (error instanceof StructuralValidationError) {
      throw new ValidationError(error.details.join("\n"));
    }
    throw error;
  }

  if (runtime.externalValidator === null) return;
  try {
    await run(runtime.externalValidator.command, [...runtime.externalValidator.args], {
      cwd: runtime.repositoryRoot,
      env: sanitizedGitEnvironment(),
      timeout: EXTERNAL_TIMEOUT_MS,
      maxBuffer: EXTERNAL_OUTPUT_BYTES,
      killSignal: "SIGKILL",
    });
  } catch (error) {
    let details = error instanceof Error ? error.message : String(error);
    if (typeof error === "object" && error !== null) {
      const output = [
        "stderr" in error ? String((error as { stderr: unknown }).stderr) : "",
        "stdout" in error ? String((error as { stdout: unknown }).stdout) : "",
      ]
        .map((part) => part.trim())
        .filter(Boolean)
        .join("\n");
      if (output) details = output;
    }
    throw new ValidationError(`external validator failed: ${details.slice(0, EXTERNAL_OUTPUT_BYTES)}`);
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

const UNSUPPORTED_DIRECTORY_SYNC_ERRORS = new Set([
  "EINVAL",
  "EISDIR",
  "ENOTSUP",
  "EOPNOTSUPP",
]);

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!UNSUPPORTED_DIRECTORY_SYNC_ERRORS.has(errorCode(error) ?? "")) throw error;
  } finally {
    await handle?.close();
  }
}

async function atomicWrite(
  absolutePath: string,
  text: string,
  mode: number,
  onReplaced: () => void = () => undefined,
): Promise<void> {
  const directory = path.dirname(absolutePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(absolutePath)}.board-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  let failed = false;
  let failure: unknown;
  try {
    const handle = await open(temporaryPath, "wx", mode);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, absolutePath);
    onReplaced();
    await syncDirectory(directory);
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    try {
      await rm(temporaryPath, { force: true });
    } catch (cleanupError) {
      if (failed) {
        throw new AggregateError(
          [failure, cleanupError],
          "atomic replacement failed and its temporary file could not be removed",
        );
      }
      throw cleanupError;
    }
  }
}

export async function applyWrite(
  runtime: BoardRuntime,
  request: WriteRequest,
  options: WriteOptions = {},
): Promise<WriteResult> {
  if (!runtime.writableFiles.has(request.file)) {
    throw new ForbiddenPathError(`${request.file} is not an editable planning document`);
  }

  return exclusive(runtime.repositoryRoot, async () => {
    const lock = await acquireLedgerLock(runtime.repositoryRoot, options.lock ?? {});
    try {
      const absolutePath = await assertSafeRepositoryFile(runtime.repositoryRoot, request.file);
      const [original, metadata] = await Promise.all([
        readFile(absolutePath, "utf8"),
        stat(absolutePath),
      ]);
      const currentSha = sha256(original);
      if (currentSha !== request.baseSha256) {
        throw new ConflictError(
          `${request.file} changed on disk since it was loaded; reload the board before editing`,
        );
      }

      let updated = original;
      if (request.edits?.length) updated = patchCells(updated, request.edits);
      if (request.move) updated = moveRow(updated, request.move);
      if (request.insert) updated = insertLines(updated, request.insert);
      if (updated === original) return { file: request.file, sha256: currentSha };

      let replacementOccurred = false;
      try {
        await atomicWrite(absolutePath, updated, metadata.mode, () => {
          replacementOccurred = true;
        });
        await validateRuntime(runtime);
        return { file: request.file, sha256: sha256(updated) };
      } catch (error) {
        if (!replacementOccurred) throw error;
        try {
          await atomicWrite(absolutePath, original, metadata.mode);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `the edit failed and exact rollback also failed for ${request.file}`,
          );
        }
        throw error;
      }
    } finally {
      await lock.release();
    }
  });
}
