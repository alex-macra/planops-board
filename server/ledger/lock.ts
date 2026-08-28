/**
 * The lock covers read, patch, atomic replacement, validation, and rollback.
 * It lives outside the checkout so acquiring it never changes Git status.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { link, open, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export class LockError extends Error {
  override readonly name = "LockError";
}

export interface LockHandle {
  readonly path: string;
  release(): Promise<void>;
}

export interface LockOptions {
  /** How long to wait for an existing lock before giving up. */
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

interface LockOwner {
  readonly pid: number;
  /** Kernel start time, so a recycled PID is not read as the same process. */
  readonly startTime: string | null;
  readonly root: string;
  readonly since: string;
  readonly nonce: string;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

export function lockPathFor(root: string): string {
  const digest = createHash("sha256").update(path.resolve(root), "utf8").digest("hex");
  return path.join(os.tmpdir(), `projects-board-ledger-${digest.slice(0, 16)}.lock`);
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * Field 22 of /proc/<pid>/stat. Everything before it is fixed width once the
 * comm field is skipped, and comm is the only field that can contain spaces or
 * parentheses, so the last ")" is the reliable anchor.
 */
function processStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close === -1) return null;
    const afterComm = stat.slice(close + 2).split(" ");
    return afterComm[19] ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether the recorded owner is still running.
 *
 * This is evidence for the refusal message only. Locks are never broken here.
 */
function isOwnerAlive(owner: LockOwner): boolean {
  if (owner.startTime !== null) {
    const current = processStartTime(owner.pid);
    // Readable and different means the PID was recycled; readable and equal
    // means the same process. Unreadable on Linux means the process is gone.
    if (current !== null) return current === owner.startTime;
    if (process.platform === "linux") return false;
  }
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to another user.
    return errorCode(error) === "EPERM";
  }
}

function parseOwner(text: string): LockOwner | null {
  try {
    const value = JSON.parse(text) as Partial<LockOwner>;
    if (typeof value.pid !== "number" || !Number.isInteger(value.pid)) return null;
    return {
      pid: value.pid,
      startTime: typeof value.startTime === "string" ? value.startTime : null,
      root: typeof value.root === "string" ? value.root : "",
      since: typeof value.since === "string" ? value.since : "",
      nonce: typeof value.nonce === "string" ? value.nonce : "",
    };
  } catch {
    return null;
  }
}

async function readToken(lockPath: string): Promise<string | null> {
  try {
    return await readFile(lockPath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function publishLock(lockPath: string, token: string): Promise<boolean> {
  const candidate = `${lockPath}.candidate-${process.pid}-${randomBytes(8).toString("hex")}`;
  let published = false;
  try {
    const handle = await open(candidate, "wx", 0o600);
    try {
      await handle.writeFile(token, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(candidate, lockPath);
      published = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    return published;
  } finally {
    try {
      await rm(candidate, { force: true });
    } catch (error) {
      if (published) await releaseOwn(lockPath, token);
      throw error;
    }
  }
}

async function releaseOwn(lockPath: string, token: string): Promise<void> {
  const current = await readToken(lockPath);
  // Only ever delete our own lock. A mismatch means this lock was already
  // broken and re-taken, and deleting it would hand the repository to two
  // writers at once.
  if (current === token) await rm(lockPath, { force: true });
}

/**
 * Deliberately not `unref`ed. A process whose only remaining work is waiting
 * for this lock must stay alive to take it; unrefing the timer let Node decide
 * the event loop was empty and exit 13 mid-wait.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Take the lock for one checkout, or throw once the wait budget is spent.
 *
 * Callers must release in a `finally`. A process that dies without releasing
 * requires explicit cleanup after a human verifies that no writer is active.
 */
async function acquireLockAt(
  lockPath: string,
  ownerRoot: string,
  options: LockOptions = {},
): Promise<LockHandle> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 25;
  const token = JSON.stringify({
    pid: process.pid,
    startTime: processStartTime(process.pid),
    root: path.resolve(ownerRoot),
    since: new Date().toISOString(),
    nonce: randomBytes(16).toString("hex"),
  } satisfies LockOwner);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const created = await publishLock(lockPath, token);

    if (created) {
      // Read our token back in case an operator changed the lock concurrently.
      if ((await readToken(lockPath)) === token) {
        let releasePromise: Promise<void> | null = null;
        return {
          path: lockPath,
          release: () => {
            releasePromise ??= releaseOwn(lockPath, token);
            return releasePromise;
          },
        };
      }
      continue;
    }

    const existing = await readToken(lockPath);
    if (existing === null) continue;
    const owner = parseOwner(existing);

    if (Date.now() >= deadline) {
      const ownerEvidence = owner === null
        ? "owner metadata is unreadable"
        : isOwnerAlive(owner)
          ? `recorded owner pid ${owner.pid} appears live (since ${owner.since})`
          : `recorded owner pid ${owner.pid} no longer appears live (since ${owner.since})`;
      throw new LockError(
        `lock ${lockPath} is still present after ${timeoutMs} ms; ${ownerEvidence}. ` +
          "Remove that exact lock only after verifying that no writer is active",
      );
    }
    await delay(pollMs);
  }
}

export async function acquireLedgerLock(
  root: string,
  options: LockOptions = {},
): Promise<LockHandle> {
  return acquireLockAt(lockPathFor(root), root, options);
}
