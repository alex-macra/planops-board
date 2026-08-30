import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

import { disposableDemo, removeDisposableDemo } from "../tests/fixture.ts";
import {
  e2ePort,
  removeE2eFixtureState,
  writeE2eFixtureState,
} from "./fixture.ts";

const port = e2ePort();

const engineRoot = path.resolve(import.meta.dirname, "..");
const createdRepositoryRoot = await disposableDemo();
const repositoryRoot = await writeE2eFixtureState(createdRepositoryRoot, port).catch(async (error) => {
  await removeDisposableDemo(createdRepositoryRoot);
  throw error;
});
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
  try {
    await removeDisposableDemo(repositoryRoot);
  } finally {
    await removeE2eFixtureState(port);
  }
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
  try {
    await removeDisposableDemo(repositoryRoot);
  } finally {
    await removeE2eFixtureState(port);
  }
  process.exitCode = code ?? 1;
}
