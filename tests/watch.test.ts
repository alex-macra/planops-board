import { mkdir, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { gitStatus } from "../server/git.ts";
import { loadBoard } from "../server/ledger/corpus.ts";
import { applyWrite } from "../server/ledger/write.ts";
import { loadBoardRuntime, type BoardRuntime } from "../server/runtime.ts";
import {
  readCorpusState,
  watchCorpus,
  type CorpusState,
  type CorpusWatcher,
} from "../server/watch.ts";
import { disposableDemo, removeDisposableDemo } from "./fixture.ts";

const roots: string[] = [];
const watchers: CorpusWatcher[] = [];

afterEach(async () => {
  for (const watcher of watchers.splice(0)) watcher.close();
  await Promise.all(roots.splice(0).map(removeDisposableDemo));
});

function fictionalPlan(id: string, outcome: string): string {
  return [
    `# ${id} plan`,
    "",
    "| ID | Priority | Status | Dependencies | Required outcome |",
    "|---|---:|---|---|---|",
    `| \`${id}\` | P2 | Ready | None | ${outcome} |`,
    "",
  ].join("\n");
}

async function waitForPublication(
  watcher: CorpusWatcher,
  action: () => Promise<void>,
  predicate: (state: CorpusState) => boolean = () => true,
): Promise<CorpusState> {
  return new Promise<CorpusState>((resolve, reject) => {
    let actionFinished = false;
    let latest: CorpusState | undefined;
    let finished = false;

    const finish = (result: CorpusState): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      unsubscribe();
      resolve(result);
    };
    const fail = (error: unknown): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      unsubscribe();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const consider = (state: CorpusState): void => {
      latest = state;
      if (actionFinished && predicate(state)) finish(state);
    };
    const unsubscribe = watcher.subscribe(consider);
    const timeout = setTimeout(
      () => fail(new Error("the watcher did not publish the expected corpus state")),
      3_000,
    );

    void action().then(() => {
      actionFinished = true;
      if (latest && predicate(latest)) finish(latest);
    }, fail);
  });
}

async function waitForRetriedPublication(
  watcher: CorpusWatcher,
  action: (attempt: number) => Promise<void>,
  predicate: (state: CorpusState) => boolean = () => true,
): Promise<CorpusState> {
  return new Promise<CorpusState>((resolve, reject) => {
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    let unsubscribe = (): void => undefined;
    const cleanup = (): void => {
      finished = true;
      clearTimeout(timeout);
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribe();
    };
    const fail = (error: unknown): void => {
      if (finished) return;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const timeout = setTimeout(
      () => fail(new Error("the watcher did not publish the expected corpus state")),
      3_000,
    );
    unsubscribe = watcher.subscribe((state) => {
      if (finished || !predicate(state)) return;
      cleanup();
      resolve(state);
    });
    const pulse = async (): Promise<void> => {
      if (finished) return;
      attempt += 1;
      await action(attempt);
      if (!finished) retryTimer = setTimeout(() => void pulse().catch(fail), 20);
    };
    void pulse().catch(fail);
  });
}

async function primedWatcher(root: string, runtime: BoardRuntime): Promise<CorpusWatcher> {
  const anchor = path.join(root, "plans", "moon-garden.md");
  const original = await readFile(anchor, "utf8");
  const initial = await readCorpusState(runtime);
  const watcher = watchCorpus(runtime, { debounceMs: 5 });
  watchers.push(watcher);

  await waitForPublication(
    watcher,
    async () => undefined,
    (state) => state.corpus === initial.corpus && state.git === initial.git,
  );

  await waitForRetriedPublication(
    watcher,
    (attempt) => writeFile(anchor, `${original}\nFictional watcher primer ${attempt}.\n`),
    (state) => state.corpus !== initial.corpus || state.git !== initial.git,
  );
  await waitForRetriedPublication(
    watcher,
    () => writeFile(anchor, original),
    (state) => state.corpus === initial.corpus && state.git === initial.git,
  );
  return watcher;
}

async function expectNoPublication(
  watcher: CorpusWatcher,
  action: () => Promise<void>,
): Promise<void> {
  let publication: CorpusState | undefined;
  let replayed = false;
  const unsubscribe = watcher.subscribe((state) => {
    if (!replayed) {
      replayed = true;
      return;
    }
    publication = state;
  });
  await action();
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  unsubscribe();
  expect(publication).toBeUndefined();
}

describe("corpus watcher", () => {
  it("publishes the latest state when a document changes during startup", async () => {
    const root = await disposableDemo("work/watch-startup");
    roots.push(root);
    const runtime = await loadBoardRuntime({ repo: root });
    const initial = await readCorpusState(runtime);
    const file = path.join(root, "plans", "moon-garden.md");
    const original = await readFile(file, "utf8");
    const watcher = watchCorpus(runtime, { debounceMs: 5 });
    watchers.push(watcher);

    const changed = await waitForPublication(
      watcher,
      () => writeFile(file, `${original}\nImmediate fictional startup edit.\n`),
      (state) => state.corpus !== initial.corpus,
    );

    expect(changed).toEqual(await readCorpusState(runtime));
  });

  it("publishes a new state after a configured document changes", async () => {
    const root = await disposableDemo("work/watch");
    roots.push(root);
    const runtime = await loadBoardRuntime({ repo: root });
    const initial = await readCorpusState(runtime);
    const file = path.join(root, "plans", "moon-garden.md");
    const original = await readFile(file, "utf8");
    const watcher = await primedWatcher(root, runtime);

    const changed = await waitForPublication(
      watcher,
      () => writeFile(file, `${original}\nFictional watcher edit.\n`),
      (state) => state.corpus !== initial.corpus,
    );

    expect(changed.corpus).not.toBe(initial.corpus);
  });

  it("discovers a matching document added after startup and makes it editable", async () => {
    const root = await disposableDemo("work/watch-add");
    roots.push(root);
    const runtime = await loadBoardRuntime({ repo: root });
    const watcher = await primedWatcher(root, runtime);
    const relative = "plans/aurora-kite.md";
    const absolute = path.join(root, relative);

    await waitForPublication(watcher, () => writeFile(
      absolute,
      fictionalPlan("AKT-001", "Launch the fictional aurora kite."),
    ));

    const board = await loadBoard(runtime);
    const task = board.tasks.find((entry) => entry.id === "AKT-001");
    const document = board.documents.find((entry) => entry.path === relative);
    expect(task?.file).toBe(relative);
    expect(document).toBeDefined();
    expect((await gitStatus(runtime)).changedPlanningFiles).toContain(relative);

    await applyWrite(runtime, {
      file: relative,
      baseSha256: document!.sha256,
      edits: [{ ...task!.statusCell!, expected: "Ready", value: "In progress" }],
    });
    await expect(readFile(absolute, "utf8")).resolves.toContain("| P2 | In progress |");
  });

  it("discovers a matching document in a newly created nested directory", async () => {
    const root = await disposableDemo("work/watch-nested");
    roots.push(root);
    const runtime = await loadBoardRuntime({ repo: root });
    const watcher = await primedWatcher(root, runtime);
    const directory = path.join(root, "plans", "expeditions", "winter");

    await waitForPublication(watcher, async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "comet-map.md"),
        fictionalPlan("CMT-001", "Map a fictional winter comet."),
      );
    });

    const board = await loadBoard(runtime);
    expect(board.tasks.find((entry) => entry.id === "CMT-001")?.file)
      .toBe("plans/expeditions/winter/comet-map.md");
  });

  it("tracks a matching document renamed to another matching path", async () => {
    const root = await disposableDemo("work/watch-rename");
    roots.push(root);
    const source = path.join(root, "plans", "incoming-ledger.md");
    const target = path.join(root, "plans", "renamed-ledger.md");
    await writeFile(source, fictionalPlan("REN-001", "Receive a renamed fictional ledger."));
    const runtime = await loadBoardRuntime({ repo: root });
    const watcher = await primedWatcher(root, runtime);

    await waitForPublication(watcher, () => rename(source, target));

    const board = await loadBoard(runtime);
    expect(board.tasks.find((entry) => entry.id === "REN-001")?.file)
      .toBe("plans/renamed-ledger.md");
    expect(board.documents.some((entry) => entry.path === "plans/incoming-ledger.md")).toBe(false);
  });

  it("removes a deleted matching document from the live board", async () => {
    const root = await disposableDemo("work/watch-delete");
    roots.push(root);
    const runtime = await loadBoardRuntime({ repo: root });
    const watcher = await primedWatcher(root, runtime);

    await waitForPublication(
      watcher,
      () => unlink(path.join(root, "plans", "signal-harbor.md")),
    );

    const board = await loadBoard(runtime);
    expect(board.documents.some((entry) => entry.path === "plans/signal-harbor.md")).toBe(false);
    expect(board.tasks.some((entry) => entry.id.startsWith("SHB-"))).toBe(false);
    const status = await gitStatus(runtime);
    expect(status.changedPlanningFiles).toContain("plans/signal-harbor.md");
    expect(status.otherChangedFiles).not.toContain("plans/signal-harbor.md");
  });

  it("publishes an empty board after the final matching document is deleted", async () => {
    const root = await disposableDemo("work/watch-delete-all");
    roots.push(root);
    const runtime = await loadBoardRuntime({ repo: root });
    const watcher = await primedWatcher(root, runtime);
    const board = await loadBoard(runtime);

    await waitForPublication(watcher, () => Promise.all(
      board.documents.map((document) => unlink(path.join(root, document.path))),
    ).then(() => undefined));

    const empty = await loadBoard(runtime);
    expect(empty.documents).toEqual([]);
    expect(empty.tasks).toEqual([]);
  });

  it("converges on the final bytes after rapid atomic replacements", async () => {
    const root = await disposableDemo("work/watch-atomic");
    roots.push(root);
    const runtime = await loadBoardRuntime({ repo: root });
    const watcher = await primedWatcher(root, runtime);
    const target = path.join(root, "plans", "moon-garden.md");
    const original = await readFile(target, "utf8");
    const final = `${original}\nFinal fictional atomic replacement.\n`;
    let expected: CorpusState | undefined;

    await waitForPublication(watcher, async () => {
      for (const [index, text] of [
        `${original}\nFirst fictional atomic replacement.\n`,
        `${original}\nSecond fictional atomic replacement.\n`,
        final,
      ].entries()) {
        const temporary = path.join(root, "plans", `.moon-garden-${index}.tmp`);
        await writeFile(temporary, text);
        await rename(temporary, target);
      }
      expected = await readCorpusState(runtime);
    }, (state) => expected !== undefined && state.corpus === expected.corpus);

    await expect(readFile(target, "utf8")).resolves.toBe(final);
    await expect(readCorpusState(runtime)).resolves.toEqual(expected);
  });

  it("does not publish for excluded or unrelated files", async () => {
    const root = await disposableDemo("work/watch-ignore");
    roots.push(root);
    const runtime = await loadBoardRuntime({ repo: root });
    const watcher = await primedWatcher(root, runtime);
    const initial = await readCorpusState(runtime);

    await expectNoPublication(watcher, async () => {
      await writeFile(
        path.join(root, "plans", "archive", "new-retired-plan.md"),
        fictionalPlan("ARC-001", "Keep an excluded fictional record."),
      );
      await writeFile(path.join(root, "plans", "watcher-notes.txt"), "Unrelated notes.\n");
      await writeFile(path.join(root, "README.md"), "# Unrelated repository notes\n");
    });

    await expect(readCorpusState(runtime)).resolves.toEqual(initial);
  });

  it("does not publish or write through a matching symlink", async () => {
    const root = await disposableDemo("work/watch-symlink");
    roots.push(root);
    const runtime = await loadBoardRuntime({ repo: root });
    const watcher = await primedWatcher(root, runtime);
    const target = path.join(root, "plans", "moon-garden.md");
    const before = await readFile(target, "utf8");

    await expectNoPublication(
      watcher,
      () => symlink("moon-garden.md", path.join(root, "plans", "linked-ledger.md")),
    );
    await expect(applyWrite(runtime, {
      file: "plans/linked-ledger.md",
      baseSha256: "0".repeat(64),
      edits: [],
    })).rejects.toThrow(/symbolic links|editable planning document/);
    await expect(readFile(target, "utf8")).resolves.toBe(before);
  });
});
