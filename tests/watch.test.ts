import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadBoardRuntime } from "../server/runtime.ts";
import { readCorpusState, watchCorpus, type CorpusState } from "../server/watch.ts";
import { disposableDemo, removeDisposableDemo } from "./fixture.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeDisposableDemo));
});

describe("corpus watcher", () => {
  it("publishes a new state after a configured document changes", async () => {
    const root = await disposableDemo("work/watch");
    roots.push(root);
    const runtime = await loadBoardRuntime({ repo: root });
    const initial = await readCorpusState(runtime);
    const file = path.join(root, "plans", "moon-garden.md");
    const original = await readFile(file, "utf8");
    const watcher = watchCorpus(runtime, { debounceMs: 5 });

    let attempt = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changedPromise = new Promise<CorpusState>((resolve, reject) => {
      const unsubscribe = watcher.subscribe((state) => {
        stopped = true;
        unsubscribe();
        if (timer) clearTimeout(timer);
        resolve(state);
      });
      const edit = async (): Promise<void> => {
        if (stopped) return;
        attempt += 1;
        if (attempt > 20) {
          stopped = true;
          unsubscribe();
          reject(new Error("the watcher did not publish a configured document change"));
          return;
        }
        await writeFile(file, `${original}\nFictional watcher edit ${attempt}.\n`);
        if (!stopped) timer = setTimeout(() => void edit(), 20);
      };
      void edit().catch((error: unknown) => {
        stopped = true;
        unsubscribe();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });

    const changed = await changedPromise.finally(() => {
      stopped = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    });
    expect(changed.corpus).not.toBe(initial.corpus);
  });
});
