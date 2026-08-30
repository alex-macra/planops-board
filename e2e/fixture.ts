import { constants } from "node:fs";
import { appendFile, lstat, open, realpath, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";

import { runGitCommand } from "../server/git-command.ts";

const stateSchema = z
  .object({
    version: z.literal(1),
    repositoryRoot: z.string().min(1),
  })
  .strict();

const TEST_DIRECTORY_PREFIX = "planops-board-test-";
const JOURNEY_BRANCH_REF = "refs/heads/plan/browser-journey";

export function e2ePort(): number {
  const port = Number(process.env["BOARD_E2E_PORT"] ?? "5175");
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("BOARD_E2E_PORT must be a valid unprivileged TCP port");
  }
  return port;
}

function statePath(port = e2ePort()): string {
  return path.join(tmpdir(), `planops-board-e2e-${port}.json`);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function removeStateFile(port = e2ePort()): Promise<void> {
  try {
    await unlink(statePath(port));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function assertDisposableRepository(repositoryRoot: string): Promise<string> {
  if (!path.isAbsolute(repositoryRoot)) {
    throw new Error("E2E repository root must be absolute");
  }

  const [canonicalRoot, canonicalTemp] = await Promise.all([
    realpath(repositoryRoot),
    realpath(tmpdir()),
  ]);
  const parent = path.dirname(canonicalRoot);
  if (
    path.basename(canonicalRoot) !== "repo" ||
    path.dirname(parent) !== canonicalTemp ||
    !path.basename(parent).startsWith(TEST_DIRECTORY_PREFIX)
  ) {
    throw new Error("E2E repository root is not a disposable PlanOps Board fixture");
  }

  const [rootStats, gitStats, configStats, planStats, readmeStats] = await Promise.all([
    lstat(canonicalRoot),
    lstat(path.join(canonicalRoot, ".git")),
    lstat(path.join(canonicalRoot, ".projects-board", "config.json")),
    lstat(path.join(canonicalRoot, "plans", "moon-garden.md")),
    lstat(path.join(canonicalRoot, "README.md")),
  ]);
  if (
    !rootStats.isDirectory() ||
    !gitStats.isDirectory() ||
    !configStats.isFile() ||
    !planStats.isFile() ||
    !readmeStats.isFile() ||
    rootStats.isSymbolicLink() ||
    gitStats.isSymbolicLink() ||
    configStats.isSymbolicLink() ||
    planStats.isSymbolicLink() ||
    readmeStats.isSymbolicLink()
  ) {
    throw new Error("E2E repository fixture has an unsafe layout");
  }

  const { stdout } = await runGitCommand(canonicalRoot, ["rev-parse", "--show-toplevel"]);
  if (await realpath(stdout.trim()) !== canonicalRoot) {
    throw new Error("E2E repository root does not match its Git root");
  }
  await runGitCommand(canonicalRoot, ["rev-parse", "--verify", "refs/heads/main"]);
  return canonicalRoot;
}

export async function writeE2eFixtureState(
  repositoryRoot: string,
  port = e2ePort(),
): Promise<string> {
  const canonicalRoot = await assertDisposableRepository(repositoryRoot);
  await removeStateFile(port);
  await writeFile(
    statePath(port),
    `${JSON.stringify({ version: 1, repositoryRoot: canonicalRoot })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  return canonicalRoot;
}

export async function removeE2eFixtureState(port = e2ePort()): Promise<void> {
  await removeStateFile(port);
}

async function readE2eFixtureState(port = e2ePort()): Promise<string> {
  const handle = await open(statePath(port), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("E2E fixture state must be a regular file");
    const state = stateSchema.parse(JSON.parse(await handle.readFile("utf8")));
    return assertDisposableRepository(state.repositoryRoot);
  } finally {
    await handle.close();
  }
}

export async function resetBrowserRepository(): Promise<void> {
  const repositoryRoot = await readE2eFixtureState();
  await runGitCommand(repositoryRoot, ["checkout", "--force", "main"]);
  await runGitCommand(repositoryRoot, ["reset", "--hard", "main"]);
  await runGitCommand(repositoryRoot, ["clean", "-fd"]);
  await runGitCommand(repositoryRoot, ["update-ref", "-d", JOURNEY_BRANCH_REF]);
  await appendFile(
    path.join(repositoryRoot, "README.md"),
    "\nUnrelated fictional browser note.\n",
    "utf8",
  );
}
