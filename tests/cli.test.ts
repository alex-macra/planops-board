import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { disposableDemo, git, removeDisposableDemo } from "./fixture.ts";

const root = path.resolve(import.meta.dirname, "..");

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(args: readonly string[], cwd = root): Promise<CliResult> {
  const child = spawn(process.execPath, [path.join(root, "cli", "planops-board.ts"), ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [code] = await once(child, "close") as [number | null, NodeJS.Signals | null];
  return { code, stdout, stderr };
}

async function withTemporaryDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), "planops-board-cli-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("PlanOps Board CLI", () => {
  test("package metadata exposes the compiled planops-board command without install lifecycles", async () => {
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
      readonly name?: unknown;
      readonly version?: unknown;
      readonly private?: unknown;
      readonly bin?: unknown;
      readonly files?: unknown;
      readonly scripts: Readonly<Record<string, string>>;
      readonly dependencies: Readonly<Record<string, string>>;
      readonly devDependencies: Readonly<Record<string, string>>;
    };
    const packageLock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8")) as {
      readonly name?: unknown;
      readonly packages?: Readonly<Record<string, { readonly name?: unknown; readonly bin?: unknown }>>;
    };

    expect(packageJson.name).toBe("planops-board");
    expect(packageJson.version).toBe("0.1.0");
    expect(packageJson).not.toHaveProperty("private");
    expect(packageJson.bin).toEqual({ "planops-board": "./bin/planops-board.js" });
    expect(packageJson.files).toEqual([
      "bin/planops-board.js",
      "dist",
      "schema",
      "examples",
      "index.html",
      "src",
      "shared",
      "public",
      "postcss.config.cjs",
      "tailwind.config.cjs",
      "SECURITY.md",
    ]);
    for (const lifecycle of [
      "install",
      "preinstall",
      "postinstall",
      "prepare",
      "prepublish",
      "prepublishOnly",
      "publish",
      "postpublish",
    ]) {
      expect(packageJson.scripts).not.toHaveProperty(lifecycle);
    }
    expect(packageJson.scripts.prepack).toBe("npm run verify");
    expect(packageJson.scripts.verify).not.toMatch(/test:package|pack/);
    for (const runtimeDependency of ["vite", "@vitejs/plugin-react-swc", "postcss", "autoprefixer", "tailwindcss"]) {
      expect(packageJson.dependencies).toHaveProperty(runtimeDependency);
      expect(packageJson.devDependencies).not.toHaveProperty(runtimeDependency);
    }
    expect(packageJson.devDependencies).toHaveProperty("esbuild");
    expect(packageLock.name).toBe("planops-board");
    expect(packageLock.packages?.[""]).toMatchObject({
      name: "planops-board",
      bin: { "planops-board": "bin/planops-board.js" },
    });
  });

  test("--help prints usage on stdout and exits successfully without a repository", async () => {
    await withTemporaryDirectory(async (directory) => {
      const result = await runCli(["--help"], directory);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/^Usage:\n/);
      expect(result.stdout).toContain("planops-board demo:init <destination>");
      expect(await readdir(directory)).toEqual([]);
    });
  });

  test("demo:init creates the fictional demo repository and prints its path", async () => {
    await withTemporaryDirectory(async (directory) => {
      const destination = path.join(directory, "demo");
      const result = await runCli(["demo:init", destination], directory);

      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(result.stdout).toBe(`${destination}\n`);
      expect(await git(destination, "rev-list", "--count", "HEAD")).toBe("2");
      expect(await readFile(path.join(destination, "plans", "moon-garden.md"), "utf8")).toContain("MGA-002");
    });
  });

  test("demo:init refuses missing, existing, broad, and engine-root destinations", async () => {
    await withTemporaryDirectory(async (directory) => {
      const missing = await runCli(["demo:init"], directory);
      expect(missing.code).toBe(1);
      expect(missing.stdout).toBe("");
      expect(missing.stderr).toContain("Usage:");
      expect(await readdir(directory)).toEqual([]);

      const existing = await runCli(["demo:init", directory], directory);
      expect(existing.code).toBe(1);
      expect(existing.stderr).toContain("destination already exists");
      expect(await readdir(directory)).toEqual([]);

      const broad = await runCli(["demo:init", "/"], directory);
      expect(broad.code).toBe(1);
      expect(broad.stderr).toContain("refusing to use a broad or engine-root destination");

      const engineRoot = await runCli(["demo:init", root], directory);
      expect(engineRoot.code).toBe(1);
      expect(engineRoot.stderr).toContain("refusing to use a broad or engine-root destination");
    });
  });

  test("invalid arguments print the planops-board command contract", async () => {
    const result = await runCli([]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("planops-board: Usage:");
    expect(result.stderr).toContain("planops-board dev --repo <path>");
    expect(result.stderr).toContain("planops-board start --repo <path>");
  });

  test("dev exits promptly when its configured port is already in use", async () => {
    const repositoryRoot = await disposableDemo();
    const portHolder = createServer();
    try {
      const listening = once(portHolder, "listening");
      portHolder.listen(0, "127.0.0.1");
      await listening;
      const address = portHolder.address();
      if (address === null || typeof address === "string") {
        throw new Error("loopback port holder did not expose a TCP address");
      }

      const child = spawn(
        process.execPath,
        ["cli/planops-board.ts", "dev", "--repo", repositoryRoot, "--port", String(address.port)],
        {
          cwd: root,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>,
          new Promise<null>((resolve) => {
            timeout = setTimeout(() => resolve(null), 5_000);
          }),
        ]);
        if (result === null) throw new Error("CLI did not exit within five seconds");

        const [code, signal] = result;
        expect(code).toBe(1);
        expect(signal).toBeNull();
        expect(stderr).toContain(`planops-board: Port ${address.port} is already in use`);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null) {
          const closed = once(child, "close");
          child.kill("SIGKILL");
          await closed;
        }
      }
    } finally {
      if (portHolder.listening) {
        await new Promise<void>((resolve, reject) => {
          portHolder.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      }
      await removeDisposableDemo(repositoryRoot);
    }
  }, 10_000);
});
