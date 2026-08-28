import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadBoard } from "../server/ledger/corpus.ts";
import { applyWrite, ForbiddenPathError, ValidationError } from "../server/ledger/write.ts";
import { ConflictError } from "../server/ledger/patch.ts";
import { loadBoardRuntime } from "../server/runtime.ts";
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
