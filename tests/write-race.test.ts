import { mkdir, readdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadBoard } from "../server/ledger/corpus.ts";
import { applyWrite } from "../server/ledger/write.ts";
import { loadBoardRuntime, RuntimeConfigError } from "../server/runtime.ts";
import { disposableDemo, removeDisposableDemo } from "./fixture.ts";

interface Hook {
  readonly target: string;
  readonly run: () => Promise<void>;
}

const hooks = vi.hoisted(() => ({
  afterReadFile: null as Hook | null,
  afterRename: null as Hook | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile: typeof actual.readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    const result = await actual.readFile(...args);
    const hook = hooks.afterReadFile;
    if (hook && String(args[0]) === hook.target) {
      hooks.afterReadFile = null;
      await hook.run();
    }
    return result;
  }) as typeof actual.readFile;
  const rename: typeof actual.rename = async (from, to) => {
    await actual.rename(from, to);
    const hook = hooks.afterRename;
    if (hook && String(to) === hook.target) {
      hooks.afterRename = null;
      await hook.run();
    }
  };
  return { ...actual, readFile, rename, default: { ...actual, readFile, rename } };
});

const OUTSIDE_MARKER = "fictional outside marker - must never change\n";
const roots: string[] = [];

afterEach(async () => {
  hooks.afterReadFile = null;
  hooks.afterRename = null;
  await Promise.all(roots.splice(0).map(removeDisposableDemo));
});

async function racedWrite() {
  const root = await disposableDemo("work/demo");
  roots.push(root);
  const runtime = await loadBoardRuntime({ repo: root });
  const board = await loadBoard(runtime, "2026-08-20T12:00:00.000Z");
  const task = board.tasks.find((entry) => entry.id === "MGA-002")!;
  const document = board.documents.find((entry) => entry.path === task.file)!;
  const outside = path.join(path.dirname(runtime.repositoryRoot), "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, path.basename(task.file)), OUTSIDE_MARKER);
  const plans = path.join(runtime.repositoryRoot, "plans");
  const swapPlans = async () => {
    await rename(plans, path.join(runtime.repositoryRoot, "plans-displaced"));
    await symlink(outside, plans, "dir");
  };
  const request = {
    file: task.file,
    baseSha256: document.sha256,
    edits: [{ ...task.statusCell!, expected: "Ready", value: "In progress" }],
  };
  return {
    runtime,
    request,
    outside,
    target: path.join(runtime.repositoryRoot, ...task.file.split("/")),
    swapPlans,
    entriesBefore: await readdir(outside),
  };
}

async function expectOutsideUntouched(outside: string, entriesBefore: readonly string[]) {
  await expect(readdir(outside)).resolves.toEqual(entriesBefore);
  await expect(readFile(path.join(outside, "moon-garden.md"), "utf8")).resolves.toBe(OUTSIDE_MARKER);
}

describe("guarded writes under a mid-operation directory swap", () => {
  it("refuses to create or replace anything outside when the directory is swapped after the guarded read", async () => {
    const { runtime, request, outside, target, swapPlans, entriesBefore } = await racedWrite();
    hooks.afterReadFile = { target, run: swapPlans };

    await expect(applyWrite(runtime, request)).rejects.toBeInstanceOf(RuntimeConfigError);

    expect(hooks.afterReadFile).toBeNull();
    await expectOutsideUntouched(outside, entriesBefore);
  });

  it("refuses to roll back outside when the directory is swapped after the replacement", async () => {
    const { runtime, request, outside, target, swapPlans, entriesBefore } = await racedWrite();
    hooks.afterRename = { target, run: swapPlans };

    const failure = await applyWrite(runtime, request).then(
      () => null,
      (error: unknown) => error,
    );

    expect(hooks.afterRename).toBeNull();
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.some((error) => error instanceof RuntimeConfigError)).toBe(true);
    await expectOutsideUntouched(outside, entriesBefore);
  });
});
