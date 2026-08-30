import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { disposableDemo, removeDisposableDemo } from "./fixture.ts";

const root = path.resolve(import.meta.dirname, "..");

describe("PlanOps Board CLI", () => {
  test("package metadata exposes the planops-board source command", async () => {
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
      readonly name?: unknown;
      readonly bin?: unknown;
    };
    const packageLock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8")) as {
      readonly name?: unknown;
      readonly packages?: Readonly<Record<string, { readonly name?: unknown; readonly bin?: unknown }>>;
    };

    expect(packageJson.name).toBe("planops-board");
    expect(packageJson.bin).toEqual({ "planops-board": "./cli/planops-board.ts" });
    expect(packageLock.name).toBe("planops-board");
    expect(packageLock.packages?.[""]).toMatchObject({
      name: "planops-board",
      bin: { "planops-board": "cli/planops-board.ts" },
    });
  });

  test("invalid arguments print the planops-board command contract", async () => {
    const child = spawn(process.execPath, ["cli/planops-board.ts"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const [code] = await once(child, "close") as [number | null, NodeJS.Signals | null];

    expect(code).toBe(1);
    expect(stderr).toContain("planops-board: Usage:");
    expect(stderr).toContain("planops-board dev --repo <path>");
    expect(stderr).toContain("planops-board start --repo <path>");
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
