import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runGitCommand } from "../server/git-command.ts";

export const demoRoot = path.resolve(import.meta.dirname, "..", "examples", "demo-repo");

export async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await runGitCommand(root, args, {
    authorDate: "2026-08-20T12:00:00Z",
    committerDate: "2026-08-20T12:00:00Z",
  });
  return stdout.trim();
}

export async function disposableDemo(branch = "main"): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), "planops-board-test-"));
  const root = path.join(parent, "repo");
  await cp(demoRoot, root, { recursive: true });
  await git(root, "init", "-b", branch);
  await git(root, "config", "user.name", "Fictional Tester");
  await git(root, "config", "user.email", "tester@example.invalid");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "Add fictional plans");
  return root;
}

export async function removeDisposableDemo(root: string): Promise<void> {
  await rm(path.dirname(root), { recursive: true, force: true });
}
