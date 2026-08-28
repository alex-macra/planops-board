import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

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
});
