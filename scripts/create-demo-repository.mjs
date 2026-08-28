import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { runGitCommand } from "../server/git-command.ts";
const source = path.resolve(import.meta.dirname, "..", "examples", "demo-repo");

async function git(root, date, ...args) {
  await runGitCommand(root, args, {
    authorDate: date,
    committerDate: date,
  });
}

export async function createDemoRepository(destination) {
  const root = path.resolve(destination);
  if (root === path.parse(root).root || root === path.resolve(import.meta.dirname, "..")) {
    throw new Error("refusing to use a broad or engine-root destination");
  }
  try {
    await stat(root);
    throw new Error(`destination already exists: ${root}`);
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
  }

  await mkdir(path.dirname(root), { recursive: true });
  await cp(source, root, { recursive: true, force: false, errorOnExist: true });
  const planPath = path.join(root, "plans", "moon-garden.md");
  const current = await readFile(planPath, "utf8");
  const finalRow = "| `MGA-002` | P1 | Ready | `MGA-001` | `moon-garden-ui` | Let visitors filter plants by light level. |";
  const initialRow = "| `MGA-002` | P2 | Blocked | `MGA-001` | `moon-garden-ui` | Let visitors filter plants by light level. |";
  if (!current.includes(finalRow)) throw new Error("the fictional history seed no longer matches the demo plan");

  await writeFile(planPath, current.replace(finalRow, initialRow), "utf8");
  await git(root, "2026-08-18T12:00:00Z", "init", "-b", "main");
  await git(root, "2026-08-18T12:00:00Z", "config", "user.name", "Fictional Demo");
  await git(root, "2026-08-18T12:00:00Z", "config", "user.email", "demo@example.invalid");
  await git(root, "2026-08-18T12:00:00Z", "add", ".");
  await git(root, "2026-08-18T12:00:00Z", "commit", "-m", "Add fictional project ledgers");

  await writeFile(planPath, current, "utf8");
  await git(root, "2026-08-20T12:00:00Z", "add", "--", "plans/moon-garden.md");
  await git(root, "2026-08-20T12:00:00Z", "commit", "-m", "Prepare catalogue filter work");
  return root;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const destination = process.argv[2];
  if (!destination) {
    process.stderr.write("Usage: npm run demo:init -- <destination>\n");
    process.exitCode = 1;
  } else {
    createDemoRepository(destination).then(
      (root) => process.stdout.write(`${root}\n`),
      (error) => {
        process.stderr.write(`planops-board demo: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      },
    );
  }
}
