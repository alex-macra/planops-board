import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";

import { chromium } from "@playwright/test";

async function running(origin: string): Promise<boolean> {
  try {
    return (await fetch(`${origin}/`, { signal: AbortSignal.timeout(1_000) })).ok;
  } catch {
    return false;
  }
}

async function waitForServer(child: ChildProcess, origin: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`PlanOps Board exited with ${child.exitCode}`);
    if (await running(origin)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("PlanOps Board did not become ready for Lighthouse");
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not allocate a Lighthouse port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function run(command: string, args: readonly string[]): Promise<void> {
  const child = spawn(command, [...args], {
    stdio: "inherit",
    env: { ...process.env, CHROME_PATH: chromium.executablePath() },
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (value) => resolve(value ?? 1));
  });
  if (code !== 0) throw new Error(`Lighthouse exited with ${code}`);
}

const temporary = await mkdtemp(path.join(tmpdir(), "planops-board-lighthouse-"));
const reportPath = path.join(temporary, "report.json");
let server: ChildProcess | null = null;
try {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  server = spawn(
    process.execPath,
    ["--import", "tsx", "e2e/serve.ts"],
    {
      stdio: "inherit",
      env: { ...process.env, BOARD_E2E_PORT: String(port) },
    },
  );
  await waitForServer(server, origin);
  await run(process.execPath, [
    path.resolve("node_modules/lighthouse/cli/index.js"),
    `${origin}/`,
    "--only-categories=accessibility",
    "--output=json",
    `--output-path=${reportPath}`,
    "--chrome-flags=--headless --no-sandbox",
    "--quiet",
  ]);
  const report = JSON.parse(await readFile(reportPath, "utf8")) as {
    categories?: { accessibility?: { score?: number } };
    audits?: Record<string, { score?: number | null; scoreDisplayMode?: string }>;
  };
  const score = report.categories?.accessibility?.score;
  if (score !== 1) {
    const failures = Object.entries(report.audits ?? {})
      .filter(([, audit]) => audit.scoreDisplayMode === "binary" && audit.score !== 1)
      .map(([id]) => id);
    throw new Error(`Lighthouse accessibility score was ${String(score)}; failures: ${failures.join(", ")}`);
  }
  process.stdout.write("Lighthouse accessibility score: 1.00\n");
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => undefined);
  }
  await rm(temporary, { recursive: true, force: true });
}
