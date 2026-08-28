import { watch, type FSWatcher } from "node:fs";
import path from "node:path";

import { gitFingerprint } from "./git.ts";
import { planningDocuments } from "./ledger/corpus.ts";
import { revisionOf } from "./ledger/model.ts";
import type { BoardRuntime } from "./runtime.ts";

export interface CorpusState {
  readonly corpus: string;
  readonly git: string;
}

const DEBOUNCE_MS = 300;
const GIT_FILES = new Set(["HEAD", "index"]);

export interface CorpusWatcher {
  subscribe(listener: (state: CorpusState) => void): () => void;
  close(): void;
}

export interface WatchOptions {
  readonly debounceMs?: number;
}

export async function readCorpusState(runtime: BoardRuntime): Promise<CorpusState> {
  const [documents, git] = await Promise.all([
    planningDocuments(runtime),
    gitFingerprint(runtime),
  ]);
  return { corpus: revisionOf(documents), git };
}

export function watchCorpus(runtime: BoardRuntime, options: WatchOptions = {}): CorpusWatcher {
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const listeners = new Set<(state: CorpusState) => void>();
  const watchers: FSWatcher[] = [];
  let last: CorpusState | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let reading = false;
  let againAfterRead = false;

  const publish = (next: CorpusState): void => {
    if (closed) return;
    const previous = last;
    last = next;
    if (previous === null) return;
    if (next.corpus === previous.corpus && next.git === previous.git) return;
    for (const listener of [...listeners]) listener(next);
  };

  const settle = (): void => {
    timer = null;
    if (reading) {
      againAfterRead = true;
      return;
    }
    reading = true;
    void readCorpusState(runtime)
      .then(publish, () => undefined)
      .finally(() => {
        reading = false;
        if (!againAfterRead || closed) return;
        againAfterRead = false;
        settle();
      });
  };

  const bump = (): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(settle, debounceMs);
  };

  const attach = (directory: string, accept: (name: string) => boolean): void => {
    try {
      const watcher = watch(directory, (_event, name) => {
        if (name === null || accept(String(name))) bump();
      });
      watcher.on("error", () => undefined);
      watchers.push(watcher);
    } catch {
      // A removed directory is covered again after restart.
    }
  };

  const byDirectory = new Map<string, Set<string>>();
  for (const relativePath of runtime.documents) {
    const directory = path.dirname(relativePath);
    const names = byDirectory.get(directory) ?? new Set<string>();
    names.add(path.basename(relativePath));
    byDirectory.set(directory, names);
  }
  for (const [directory, names] of byDirectory) {
    attach(path.join(runtime.repositoryRoot, directory), (name) => names.has(name));
  }
  attach(runtime.gitDirectory, (name) => GIT_FILES.has(name));
  settle();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      listeners.clear();
      for (const watcher of watchers) watcher.close();
      watchers.length = 0;
    },
  };
}

interface SharedWatcher {
  readonly watcher: CorpusWatcher;
  subscribers: number;
}

const shared = new Map<string, SharedWatcher>();

export function subscribeToCorpus(
  runtime: BoardRuntime,
  listener: (state: CorpusState) => void,
): () => void {
  let entry = shared.get(runtime.repositoryRoot);
  if (!entry) {
    entry = { watcher: watchCorpus(runtime), subscribers: 0 };
    shared.set(runtime.repositoryRoot, entry);
  }
  entry.subscribers += 1;
  const unsubscribe = entry.watcher.subscribe(listener);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    unsubscribe();
    const current = shared.get(runtime.repositoryRoot);
    if (!current) return;
    current.subscribers -= 1;
    if (current.subscribers > 0) return;
    current.watcher.close();
    shared.delete(runtime.repositoryRoot);
  };
}
