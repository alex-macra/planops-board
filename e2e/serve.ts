import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile } from "node:fs/promises";
import path from "node:path";

import { disposableDemo, removeDisposableDemo } from "../tests/fixture.ts";

const port = Number(process.env["BOARD_E2E_PORT"] ?? "5175");
if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
  throw new Error("BOARD_E2E_PORT must be a valid unprivileged TCP port");
}

const engineRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = await disposableDemo();
await appendFile(path.join(repositoryRoot, "README.md"), "\nUnrelated fictional browser note.\n");
const child = spawn(
  process.execPath,
  ["--import", "tsx", "cli/planops-board.ts", "dev", "--repo", repositoryRoot, "--port", String(port)],
  { cwd: engineRoot, stdio: "inherit" },
);
const childExit = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;

let stopping = false;
async function stop(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
  await childExit.catch(() => undefined);
  await removeDisposableDemo(repositoryRoot);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void stop(signal).finally(() => process.exit(0));
  });
}

child.once("error", (error) => {
  process.stderr.write(`planops-board browser fixture failed: ${String(error)}\n`);
});
const [code] = await childExit;
if (!stopping) {
  stopping = true;
  await removeDisposableDemo(repositoryRoot);
  process.exitCode = code ?? 1;
}
