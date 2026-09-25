import { copyFile, link, mkdir, readdir, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadBoard } from "../server/ledger/corpus.ts";
import { acquireLedgerLock, LockError } from "../server/ledger/lock.ts";
import { applyWrite, ForbiddenPathError, ValidationError } from "../server/ledger/write.ts";
import { ConflictError } from "../server/ledger/patch.ts";
import { loadBoardRuntime, RuntimeConfigError } from "../server/runtime.ts";
import { disposableDemo, removeDisposableDemo } from "./fixture.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeDisposableDemo));
});

async function editableTask(id = "MGA-002", allowExternalValidator = false) {
  const root = await disposableDemo("work/demo");
  roots.push(root);
  const runtime = await loadBoardRuntime({ repo: root, allowExternalValidator });
  const board = await loadBoard(runtime, "2026-08-20T12:00:00.000Z");
  const task = board.tasks.find((entry) => entry.id === id);
  if (!task?.statusCell) throw new Error(`${id} has no status cell`);
  const document = board.documents.find((entry) => entry.path === task.file);
  if (!document) throw new Error(`${task.file} is not loaded`);
  return { root, runtime, task, document, statusCell: task.statusCell };
}

describe("guarded writes", () => {
  it("rewrites only the expected configured Markdown cell", async () => {
    const { root, runtime, task, document, statusCell } = await editableTask();
    const absolute = path.join(root, task.file);
    const before = await readFile(absolute, "utf8");
    await applyWrite(runtime, {
      file: task.file,
      baseSha256: document.sha256,
      edits: [{ ...statusCell, expected: "Ready", value: "In progress" }],
    });
    const after = await readFile(absolute, "utf8");
    expect(after).toBe(before.replace("| P1 | Ready | `MGA-001` |", "| P1 | In progress | `MGA-001` |"));
  });

  it("rejects a stale SHA without changing the file", async () => {
    const { root, runtime, task, document, statusCell } = await editableTask();
    const absolute = path.join(root, task.file);
    const current = (await readFile(absolute, "utf8")).replace("Moon Garden", "Moon Garden updated");
    await writeFile(absolute, current);
    await expect(
      applyWrite(runtime, {
        file: task.file,
        baseSha256: document.sha256,
        edits: [{ ...statusCell, expected: "Ready", value: "In progress" }],
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(readFile(absolute, "utf8")).resolves.toBe(current);
  });

  it("rejects a path that was not discovered by the config", async () => {
    const { runtime, document } = await editableTask();
    await expect(
      applyWrite(runtime, {
        file: "README.md",
        baseSha256: document.sha256,
        edits: [],
      }),
    ).rejects.toBeInstanceOf(ForbiddenPathError);
  });

  it("restores exact bytes after bundled validation fails", async () => {
    const { root, runtime, task, document, statusCell } = await editableTask();
    const absolute = path.join(root, task.file);
    const before = await readFile(absolute, "utf8");
    await expect(
      applyWrite(runtime, {
        file: task.file,
        baseSha256: document.sha256,
        edits: [{ ...statusCell, expected: "Ready", value: "Vanished" }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(readFile(absolute, "utf8")).resolves.toBe(before);
  });

  it("removes atomic temporary files after rollback", async () => {
    const { root, runtime, task, document, statusCell } = await editableTask();
    await expect(
      applyWrite(runtime, {
        file: task.file,
        baseSha256: document.sha256,
        edits: [{ ...statusCell, expected: "Ready", value: "Vanished" }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    const entries = await readdir(path.join(root, "plans"));
    expect(entries.filter((entry) => entry.includes(".board-") && entry.endsWith(".tmp"))).toEqual([]);
  });

  it("restores exact bytes after the opted-in validator hook fails", async () => {
    const root = await disposableDemo("work/demo");
    roots.push(root);
    await writeFile(
      path.join(root, ".projects-board", "validate"),
      "#!/bin/sh\nprintf 'fictional validator refusal' >&2\nexit 7\n",
      { mode: 0o755 },
    );
    const runtime = await loadBoardRuntime({ repo: root, allowExternalValidator: true });
    const board = await loadBoard(runtime);
    const task = board.tasks.find((entry) => entry.id === "MGA-002")!;
    const document = board.documents.find((entry) => entry.path === task.file)!;
    const absolute = path.join(root, task.file);
    const before = await readFile(absolute, "utf8");
    await expect(
      applyWrite(runtime, {
        file: task.file,
        baseSha256: document.sha256,
        edits: [{ ...task.statusCell!, expected: "Ready", value: "In progress" }],
      }),
    ).rejects.toMatchObject({ details: expect.stringContaining("fictional validator refusal") });
    await expect(readFile(absolute, "utf8")).resolves.toBe(before);
  });
});

const OUTSIDE_SECRET = "fictional outside secret - must never change\n";

async function hostileFixture(writable?: readonly string[]) {
  const root = await disposableDemo("work/demo");
  roots.push(root);
  if (writable) {
    const configPath = path.join(root, ".projects-board", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as { documents: object };
    await writeFile(configPath, JSON.stringify({
      ...config,
      version: 2,
      documents: { ...config.documents, writable },
    }));
  }
  const runtime = await loadBoardRuntime({ repo: root });
  const board = await loadBoard(runtime, "2026-08-20T12:00:00.000Z");
  const task = board.tasks.find((entry) => entry.id === "MGA-002")!;
  const document = board.documents.find((entry) => entry.path === task.file)!;
  const repositoryRoot = runtime.repositoryRoot;
  const outside = path.join(path.dirname(repositoryRoot), "outside");
  await mkdir(outside);
  const secret = path.join(outside, "secret.md");
  await writeFile(secret, OUTSIDE_SECRET);
  const target = path.join(repositoryRoot, ...task.file.split("/"));
  const request = (value = "In progress") => ({
    file: task.file,
    baseSha256: document.sha256,
    edits: [{ ...task.statusCell!, expected: "Ready", value }],
  });
  return { runtime, board, task, document, repositoryRoot, outside, secret, target, request };
}

async function snapshot(files: readonly string[]): Promise<readonly string[]> {
  return Promise.all(files.map((file) => readFile(file, "utf8")));
}

const traversalValues = [
  "../outside/secret.md",
  "plans/../../outside/secret.md",
  null,
  "plans/./moon-garden.md",
  "plans//moon-garden.md",
  "plans\\moon-garden.md",
  "plans/moon-garden.md\0",
  "plans/archive/retired-experiment.md",
  "README.md",
  ".projects-board/config.json",
  "plans/%2e%2e/README.md",
] as const;

describe.each([
  { label: "version one", writable: undefined },
  { label: "version two", writable: ["plans/moon-garden.md"] },
])("hostile write paths under $label", ({ writable }) => {
  it.each(traversalValues.map((value) => [value ?? "<absolute outside path>", value] as const))(
    "refuses %j before any mutation",
    async (_label, value) => {
      const fixture = await hostileFixture(writable);
      const file = value ?? fixture.secret;
      const guarded = [fixture.secret, fixture.target, path.join(fixture.repositoryRoot, "README.md")];
      const before = await snapshot(guarded);
      await expect(
        applyWrite(fixture.runtime, { ...fixture.request(), file }),
      ).rejects.toBeInstanceOf(ForbiddenPathError);
      await expect(snapshot(guarded)).resolves.toEqual(before);
      await expect(readFile(fixture.secret, "utf8")).resolves.toBe(OUTSIDE_SECRET);
    },
  );
});

describe("hostile write fixtures", () => {
  it("refuses a readable but non-writable document under a version two writable subset", async () => {
    const { runtime, board, repositoryRoot, secret } = await hostileFixture(["plans/moon-garden.md"]);
    const readableOnly = board.documents.find((entry) => entry.path === "plans/shared-observatory.md")!;
    const absolute = path.join(repositoryRoot, "plans", "shared-observatory.md");
    const before = await readFile(absolute, "utf8");
    await expect(
      applyWrite(runtime, { file: readableOnly.path, baseSha256: readableOnly.sha256, edits: [] }),
    ).rejects.toBeInstanceOf(ForbiddenPathError);
    await expect(readFile(absolute, "utf8")).resolves.toBe(before);
    await expect(readFile(secret, "utf8")).resolves.toBe(OUTSIDE_SECRET);
  });

  it("refuses a planning file swapped for a symlink after the board loaded", async () => {
    const { runtime, outside, target, request } = await hostileFixture();
    const outsideCopy = path.join(outside, "moon-garden.md");
    await copyFile(target, outsideCopy);
    const outsideBefore = await readFile(outsideCopy, "utf8");
    await unlink(target);
    await symlink(outsideCopy, target, "file");
    await expect(applyWrite(runtime, request())).rejects.toBeInstanceOf(ForbiddenPathError);
    await expect(readFile(outsideCopy, "utf8")).resolves.toBe(outsideBefore);
  });

  it("refuses a planning directory swapped for a symlink after the board loaded", async () => {
    const { runtime, repositoryRoot, outside, target, request } = await hostileFixture();
    const outsideCopy = path.join(outside, "moon-garden.md");
    await copyFile(target, outsideCopy);
    const outsideBefore = await readFile(outsideCopy, "utf8");
    const plans = path.join(repositoryRoot, "plans");
    await rename(plans, path.join(repositoryRoot, "plans-displaced"));
    await symlink(outside, plans, "dir");
    const entriesBefore = await readdir(outside);
    await expect(applyWrite(runtime, request())).rejects.toBeInstanceOf(RuntimeConfigError);
    await expect(readFile(outsideCopy, "utf8")).resolves.toBe(outsideBefore);
    await expect(readdir(outside)).resolves.toEqual(entriesBefore);
  });

  it("breaks a hardlink alias instead of writing through it", async () => {
    const { runtime, outside, target, request } = await hostileFixture();
    const alias = path.join(outside, "alias.md");
    await link(target, alias);
    const before = await readFile(alias, "utf8");
    await applyWrite(runtime, request());
    await expect(readFile(alias, "utf8")).resolves.toBe(before);
    await expect(readFile(target, "utf8")).resolves.toBe(
      before.replace("| P1 | Ready | `MGA-001` |", "| P1 | In progress | `MGA-001` |"),
    );
  });

  it("lets exactly one of two same-base writers win", async () => {
    const { runtime, target, request, secret } = await hostileFixture();
    const before = await readFile(target, "utf8");
    const values = ["In progress", "Blocked"] as const;
    const results = await Promise.allSettled(values.map((value) => applyWrite(runtime, request(value))));
    const fulfilled = results.flatMap((result, index) => result.status === "fulfilled" ? [values[index]] : []);
    const rejected = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toBeInstanceOf(ConflictError);
    await expect(readFile(target, "utf8")).resolves.toBe(
      before.replace("| P1 | Ready | `MGA-001` |", `| P1 | ${fulfilled[0]} | \`MGA-001\` |`),
    );
    await expect(readFile(secret, "utf8")).resolves.toBe(OUTSIDE_SECRET);
  });

  it("refuses to write while another holder owns the ledger lock", async () => {
    const { runtime, target, request } = await hostileFixture();
    const before = await readFile(target, "utf8");
    const held = await acquireLedgerLock(runtime.repositoryRoot);
    try {
      await expect(
        applyWrite(runtime, request(), { lock: { timeoutMs: 100, pollMs: 10 } }),
      ).rejects.toBeInstanceOf(LockError);
      await expect(readFile(target, "utf8")).resolves.toBe(before);
    } finally {
      await held.release();
    }
  });
});
