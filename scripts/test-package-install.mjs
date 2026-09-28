import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { connect, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { runGitCommand } from "../server/git-command.ts";
import { reviewInstalledInstallScripts } from "./dependency-install-scripts.ts";

const root = path.resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const expectedTarball = `${packageJson.name}-${packageJson.version}.tgz`;
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const startupTimeoutMs = 30_000;
const requestTimeoutMs = 10_000;
const shutdownTimeoutMs = 10_000;
const forbiddenLifecycles = [
  "install",
  "preinstall",
  "postinstall",
  "prepare",
  "prepublish",
  "prepublishOnly",
  "publish",
  "postpublish",
];
const credentialVariables = new Set(["NPM_TOKEN", "NODE_AUTH_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"]);
const liveGroups = new Set();
let temporaryRoot;

function fail(message) {
  throw new Error(message);
}

function log(message) {
  process.stdout.write(`test:package: ${message}\n`);
}

async function assertIsolatedNpmEnvironment(environment) {
  const problems = [];
  for (const name of ["HOME", "npm_config_userconfig", "npm_config_globalconfig", "npm_config_cache"]) {
    if (!environment[name]) problems.push(`${name} must be set`);
  }
  for (const name of Object.keys(environment)) {
    const lower = name.toLowerCase();
    if (credentialVariables.has(name.toUpperCase())) {
      problems.push(`${name} must not be set`);
    } else if (
      lower.startsWith("npm_config_") &&
      (lower.endsWith("_authtoken") || lower.endsWith("_auth") || lower.endsWith("_password"))
    ) {
      problems.push(`${name} must not be set`);
    }
  }
  for (const name of ["npm_config_userconfig", "npm_config_globalconfig"]) {
    const file = environment[name];
    if (!file) continue;
    try {
      if ((await stat(file)).size !== 0) problems.push(`${name} must point to an empty or absent file`);
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
    }
  }
  if (problems.length > 0) {
    fail(`the npm environment is not isolated:\n  ${problems.join("\n  ")}`);
  }
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function waitForGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (groupAlive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

function spawnGroup(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: process.env,
    detached: true,
    stdio: ["ignore", "pipe", options.inheritStderr ? "inherit" : "pipe"],
  });
  liveGroups.add(child.pid);
  const output = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output.stdout += chunk;
  });
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      output.stderr += chunk;
    });
  }
  const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));
  const closed = once(child, "close");
  return { child, output, exited, closed };
}

async function reapGroup(pid, label) {
  if (await waitForGroupExit(pid, shutdownTimeoutMs)) {
    liveGroups.delete(pid);
    return;
  }
  killGroup(pid, "SIGKILL");
  await waitForGroupExit(pid, shutdownTimeoutMs);
  liveGroups.delete(pid);
  fail(`${label} left a child process running after it exited`);
}

async function run(command, args, { cwd, timeoutMs, inheritStderr = false }) {
  const label = `${path.basename(command)} ${args.join(" ")}`;
  const task = spawnGroup(command, args, { cwd, inheritStderr });
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const result = await Promise.race([task.exited, timedOut]);
  clearTimeout(timer);
  if (result === null) {
    killGroup(task.child.pid, "SIGKILL");
    await waitForGroupExit(task.child.pid, shutdownTimeoutMs);
    liveGroups.delete(task.child.pid);
    fail(`${label} did not finish within ${timeoutMs} ms`);
  }
  await task.closed;
  await reapGroup(task.child.pid, label);
  return { ...result, ...task.output };
}

async function git(cwd, ...args) {
  return (await runGitCommand(cwd, args)).stdout;
}

async function filesUnder(directory, prefix) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await filesUnder(path.join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
    else fail(`unexpected non-regular file in the package input: ${relative}`);
  }
  return files;
}

async function expectedInventory() {
  const tracked = (await git(root, "ls-files", "-z", "--", "schema", "examples", "public", "shared", "src"))
    .split("\0")
    .filter(Boolean);
  for (const required of ["examples/demo-repo/.projects-board/config.json", "shared/config.ts"]) {
    if (!tracked.includes(required)) fail(`expected tracked package input is missing: ${required}`);
  }
  return new Set([
    "package.json",
    "README.md",
    "LICENSE",
    "SECURITY.md",
    "bin/planops-board.js",
    "index.html",
    "postcss.config.cjs",
    "tailwind.config.cjs",
    ...tracked,
    ...await filesUnder(path.join(root, "dist"), "dist"),
  ]);
}

function tarEntries(archive) {
  const buffer = gunzipSync(archive);
  const entries = [];
  let offset = 0;
  let extendedPath;
  const text = (header, start, length) =>
    header.subarray(start, start + length).toString("utf8").replace(/\0[\s\S]*$/, "");
  const octal = (header, start, length) => Number.parseInt(text(header, start, length).trim() || "0", 8);
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    const type = text(header, 156, 1) || "0";
    const body = buffer.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      for (const record of body.toString("utf8").split("\n").filter(Boolean)) {
        const match = /^\d+ path=(.*)$/.exec(record);
        if (match) extendedPath = match[1];
      }
      continue;
    }
    if (type === "g") continue;
    const prefix = text(header, 257, 6).startsWith("ustar") ? text(header, 345, 155) : "";
    const name = extendedPath ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100));
    extendedPath = undefined;
    entries.push({ name, type, mode: octal(header, 100, 8) & 0o7777 });
  }
  return entries;
}

function parsePackJson(stdout) {
  const lines = stdout.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index] !== "[") continue;
    try {
      return JSON.parse(lines.slice(index).join("\n"));
    } catch {
      continue;
    }
  }
  fail("npm pack --json did not print a JSON result");
}

async function packPackage(packDirectory) {
  const result = await run(npmCommand, ["pack", "--json", "--pack-destination", packDirectory], {
    cwd: root,
    timeoutMs: 600_000,
    inheritStderr: true,
  });
  if (result.code !== 0) fail(`npm pack exited with ${result.code ?? result.signal}`);
  const report = parsePackJson(result.stdout);
  if (!Array.isArray(report) || report.length !== 1) fail("npm pack must produce exactly one package");
  if (report[0].filename !== expectedTarball) fail(`unexpected tarball name: ${report[0].filename}`);
  const produced = await readdir(packDirectory);
  if (produced.length !== 1 || produced[0] !== expectedTarball) {
    fail(`the pack destination must hold only ${expectedTarball}: ${produced.join(", ")}`);
  }
  const tarball = path.join(packDirectory, expectedTarball);
  const archive = await readFile(tarball);
  const entries = tarEntries(archive);
  const files = entries.filter((entry) => entry.type === "0");
  const unexpectedTypes = entries.filter((entry) => entry.type !== "0" && entry.type !== "5");
  if (unexpectedTypes.length > 0) {
    fail(`tarball holds non-file entries: ${unexpectedTypes.map((entry) => entry.name).join(", ")}`);
  }
  const actual = new Set();
  for (const file of files) {
    if (!file.name.startsWith("package/")) fail(`tar entry is outside package/: ${file.name}`);
    const relative = file.name.slice("package/".length);
    if (actual.has(relative)) fail(`duplicate tar entry: ${relative}`);
    actual.add(relative);
  }
  const expected = await expectedInventory();
  const extra = [...actual].filter((file) => !expected.has(file)).sort();
  const missing = [...expected].filter((file) => !actual.has(file)).sort();
  if (extra.length > 0 || missing.length > 0) {
    fail(`tarball inventory mismatch\n  extra: ${extra.join(", ") || "none"}\n  missing: ${missing.join(", ") || "none"}`);
  }
  const reported = new Set(report[0].files.map((file) => file.path));
  if (reported.size !== actual.size || [...actual].some((file) => !reported.has(file))) {
    fail("npm pack --json disagrees with the tarball entries");
  }
  const executable = files.find((file) => file.name === "package/bin/planops-board.js");
  if (executable?.mode !== 0o755) {
    fail(`bin/planops-board.js must have mode 0755 in the tarball, found ${executable?.mode.toString(8)}`);
  }
  const head = (await git(root, "rev-parse", "HEAD")).trim();
  const dirty = (await git(root, "status", "--porcelain=v1", "--untracked-files=all")).length > 0;
  const sha256 = createHash("sha256").update(archive).digest("hex");
  log(`packed ${expectedTarball} entries=${actual.size} sha256=${sha256} head=${head} dirty=${dirty}`);
  return tarball;
}

async function installPackage(tarball, prefix) {
  await mkdir(prefix);
  const result = await run(
    npmCommand,
    ["install", "--omit=dev", "--no-audit", "--no-fund", "--prefix", prefix, tarball],
    { cwd: prefix, timeoutMs: 300_000, inheritStderr: true },
  );
  if (result.code !== 0) fail(`npm install exited with ${result.code ?? result.signal}`);
  const executable = path.join(prefix, "node_modules", ".bin", "planops-board");
  await access(executable);
  const installedManifest = JSON.parse(
    await readFile(path.join(prefix, "node_modules", packageJson.name, "package.json"), "utf8"),
  );
  const lifecycles = forbiddenLifecycles.filter((name) => installedManifest.scripts?.[name] !== undefined);
  if (lifecycles.length > 0) fail(`the installed package defines lifecycle scripts: ${lifecycles.join(", ")}`);

  const installedLock = JSON.parse(await readFile(path.join(prefix, "node_modules", ".package-lock.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const review = reviewInstalledInstallScripts(lock, installedLock, process.platform);
  if (review.entries.length === 0) log("dependency install scripts: none");
  for (const entry of review.entries) {
    if (entry.lockVersions.length === 0) {
      log(`dependency install script ${entry.name}@${entry.version} outside the lockfile name set`);
      continue;
    }
    const lockLabel = entry.lockVersions.map((version) => `${entry.name}@${version}`).join(", ");
    const comparison = entry.differsFromLock ? "differs from lock" : "matches lock";
    log(`dependency install script ${entry.name}@${entry.version} allowed by name; lock ${lockLabel}; ${comparison}`);
  }
  if (review.outside.length > 0) {
    fail(`installed dependencies run install scripts outside the lockfile name set: ${review.outside.join(", ")}`);
  }
  return executable;
}

async function emptyDirectory(parent, name) {
  const directory = path.join(parent, name);
  await mkdir(directory);
  return directory;
}

async function assertEmpty(directory, label) {
  const entries = await readdir(directory);
  if (entries.length > 0) fail(`${label} left files in its working directory: ${entries.join(", ")}`);
}

async function helpJourney(executable, work) {
  const cwd = await emptyDirectory(work, "help");
  const result = await run(executable, ["--help"], { cwd, timeoutMs: 30_000 });
  if (result.code !== 0) fail(`--help exited with ${result.code ?? result.signal}`);
  if (!/^Usage:$/m.test(result.stdout)) fail("--help did not print Usage: on stdout");
  if (result.stderr !== "") fail(`--help wrote to stderr: ${result.stderr}`);
  await assertEmpty(cwd, "--help");
  log("help journey passed");
}

async function expectRefusal(executable, args, cwd, label) {
  const result = await run(executable, args, { cwd, timeoutMs: 30_000 });
  if (result.code !== 1) fail(`${label} exited with ${result.code ?? result.signal}, expected 1`);
  if (result.stderr.trim() === "") fail(`${label} did not explain the refusal on stderr`);
}

async function demoJourney(executable, work) {
  const parent = await emptyDirectory(work, "demo");
  const destination = path.join(parent, "repo");
  const created = await run(executable, ["demo:init", destination], { cwd: parent, timeoutMs: 60_000 });
  if (created.code !== 0) fail(`demo:init exited with ${created.code ?? created.signal}: ${created.stderr}`);
  if (created.stdout !== `${destination}\n`) fail(`demo:init printed ${JSON.stringify(created.stdout)}`);
  if ((await git(destination, "rev-list", "--count", "HEAD")).trim() !== "2") {
    fail("demo:init must create exactly two commits");
  }
  await access(path.join(destination, "plans", "moon-garden.md"));

  const parentBefore = (await readdir(parent)).join("\n");
  await expectRefusal(executable, ["demo:init", destination], parent, "demo:init with an existing destination");
  if ((await readdir(parent)).join("\n") !== parentBefore) fail("a refused demo:init changed its parent directory");
  if ((await git(destination, "rev-list", "--count", "HEAD")).trim() !== "2") {
    fail("a refused demo:init changed the existing repository");
  }

  const missingCwd = await emptyDirectory(work, "demo-missing");
  await expectRefusal(executable, ["demo:init"], missingCwd, "demo:init without a destination");
  await assertEmpty(missingCwd, "demo:init without a destination");

  const rootBefore = (await readdir("/")).join("\n");
  await expectRefusal(executable, ["demo:init", "/"], missingCwd, "demo:init with /");
  if ((await readdir("/")).join("\n") !== rootBefore) fail("a refused demo:init changed /");

  const packageRoot = path.resolve(path.dirname(await realpath(executable)), "..");
  await expectRefusal(executable, ["demo:init", packageRoot], missingCwd, "demo:init with the package root");
  await assertEmpty(missingCwd, "demo:init refusals");
  log("demo journey passed");
  return destination;
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function connectionResult(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("timeout");
    }, 3_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve("connected");
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      resolve(error.code ?? "error");
    });
  });
}

async function request(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
  return { status: response.status, type: response.headers.get("content-type") ?? "", body: await response.text() };
}

async function startServer(executable, args, cwd, readyPattern, label) {
  const task = spawnGroup(executable, args, { cwd });
  const deadline = Date.now() + startupTimeoutMs;
  while (true) {
    const output = task.output.stdout.replace(/\u001b\[[0-9;]*m/g, "");
    if (readyPattern.test(output)) return task;
    if (task.child.exitCode !== null || task.child.signalCode !== null) {
      await reapGroup(task.child.pid, label);
      fail(`${label} exited before it was ready: ${task.output.stderr}`);
    }
    if (Date.now() > deadline) {
      fail(`${label} did not report its URL within ${startupTimeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function stopServer(task, port, label) {
  killGroup(task.child.pid, "SIGTERM");
  let timer;
  const stopped = await Promise.race([
    task.exited,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), shutdownTimeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (stopped === null) {
    killGroup(task.child.pid, "SIGKILL");
    await task.exited;
  }
  await reapGroup(task.child.pid, label);
  const after = await connectionResult("127.0.0.1", port);
  if (after !== "ECONNREFUSED") fail(`${label} left port ${port} open (${after})`);
  if (stopped === null) fail(`${label} ignored SIGTERM for ${shutdownTimeoutMs} ms`);
}

async function assertBoardApi(base, label) {
  const board = await request(`${base}/api/board`);
  if (board.status !== 200 || !board.type.includes("application/json")) {
    fail(`${label} GET /api/board returned ${board.status} ${board.type}`);
  }
  JSON.parse(board.body);
}

async function crawlModules(base) {
  const queue = ["/src/main.tsx", "/@vite/client"];
  const seen = new Set(queue);
  const failures = [];
  while (queue.length > 0) {
    const modulePath = queue.shift();
    const response = await request(`${base}${modulePath}`);
    if (response.status !== 200) {
      failures.push({ modulePath, status: response.status });
      continue;
    }
    for (const match of response.body.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\/[^"'\s]+)["']/g)) {
      const specifier = match[1];
      if (seen.has(specifier)) continue;
      if (seen.size >= 2_000) fail("the development module graph exceeded 2000 modules");
      seen.add(specifier);
      queue.push(specifier);
    }
  }
  return { count: seen.size, failures };
}

async function devJourney(executable, work, repository) {
  const cwd = await emptyDirectory(work, "dev");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const label = "installed dev";
  const task = await startServer(
    executable,
    ["dev", "--repo", repository, "--port", String(port)],
    cwd,
    new RegExp(`http://127\\.0\\.0\\.1:${port}/`),
    label,
  );
  try {
    const index = await request(`${base}/`);
    if (index.status !== 200) fail(`${label} GET / returned ${index.status}`);
    let crawl = await crawlModules(base);
    for (let attempt = 1; attempt < 3 && crawl.failures.length > 0; attempt += 1) {
      if (crawl.failures.some((entry) => entry.status !== 504)) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      crawl = await crawlModules(base);
    }
    if (crawl.failures.length > 0) {
      fail(`${label} module crawl failed: ${crawl.failures.map((entry) => `${entry.modulePath} ${entry.status}`).join(", ")}`);
    }
    const styles = await request(`${base}/src/styles.css`);
    if (styles.status !== 200 || !styles.body.includes(".bg-ui-bg")) {
      fail(`${label} did not compile the Tailwind styles (${styles.status})`);
    }
    await assertBoardApi(base, label);
    log(`dev journey served ${crawl.count} modules`);
  } finally {
    await stopServer(task, port, label);
  }
  await assertEmpty(cwd, label);
}

function externalIpv4() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return null;
}

async function startJourney(executable, work, repository) {
  const cwd = await emptyDirectory(work, "start");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const label = "installed start";
  const task = await startServer(
    executable,
    ["start", "--repo", repository, "--port", String(port)],
    cwd,
    new RegExp(`PlanOps Board on http://127\\.0\\.0\\.1:${port}\\n`),
    label,
  );
  try {
    const index = await request(`${base}/`);
    if (index.status !== 200) fail(`${label} GET / returned ${index.status}`);
    const asset = /\/assets\/index-[A-Za-z0-9_-]+\.js/.exec(index.body)?.[0];
    if (!asset) fail(`${label} index does not reference a built script`);
    const script = await request(`${base}${asset}`);
    if (script.status !== 200) fail(`${label} GET ${asset} returned ${script.status}`);
    await assertBoardApi(base, label);
    const external = externalIpv4();
    if (external !== null) {
      const result = await connectionResult(external, port);
      if (result !== "ECONNREFUSED") fail(`${label} accepted or hung on ${external}:${port} (${result})`);
      log(`start journey refused ${external}:${port}`);
    } else {
      log("start journey found no external IPv4 address to probe");
    }
    log("start journey passed");
  } finally {
    await stopServer(task, port, label);
  }
  await assertEmpty(cwd, label);
}

function emergencyCleanup() {
  for (const pid of liveGroups) killGroup(pid, "SIGKILL");
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    emergencyCleanup();
    process.exit(1);
  });
}

try {
  await assertIsolatedNpmEnvironment(process.env);
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "planops-board-package-"));
  const packDirectory = await emptyDirectory(temporaryRoot, "pack");
  const work = await emptyDirectory(temporaryRoot, "work");
  const tarball = await packPackage(packDirectory);
  const executable = await installPackage(tarball, path.join(temporaryRoot, "prefix"));
  await helpJourney(executable, work);
  const repository = await demoJourney(executable, work);
  await devJourney(executable, work, repository);
  await startJourney(executable, work, repository);
  log("all package journeys passed");
} catch (error) {
  process.stderr.write(`test:package: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  for (const pid of liveGroups) {
    killGroup(pid, "SIGKILL");
    await waitForGroupExit(pid, shutdownTimeoutMs);
  }
  liveGroups.clear();
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
}
