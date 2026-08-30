import { watch, type FSWatcher } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import fastGlob from "fast-glob";

import { gitFingerprint, planningGitAllowlist } from "./git.ts";
import { planningDocuments } from "./ledger/corpus.ts";
import { revisionOf } from "./ledger/model.ts";
import { assertSafeRepositoryDirectory, type BoardRuntime } from "./runtime.ts";

export interface CorpusState {
  readonly corpus: string;
  readonly git: string;
}

const DEBOUNCE_MS = 300;
const WATCH_RETRY_MS = 1_000;
const WATCH_RETRY_MAX_MS = 30_000;
const GIT_FILES = new Set(["HEAD", "index"]);

export interface CorpusWatcher {
  subscribe(listener: (state: CorpusState) => void): () => void;
  close(): void;
}

export interface WatchOptions {
  readonly debounceMs?: number;
}

interface DocumentWatchRoot {
  readonly relativePath: string;
  readonly recursive: boolean;
}

function documentWatchRoots(runtime: BoardRuntime): DocumentWatchRoot[] {
  const byBase = new Map<string, boolean>();
  for (const task of fastGlob.generateTasks(runtime.config.documents.include)) {
    const relativePath = task.base === "." ? "" : task.base.split(path.sep).join("/");
    const recursive = task.positive.some((pattern) => path.posix.dirname(pattern).includes("*"));
    byBase.set(relativePath, (byBase.get(relativePath) ?? false) || recursive);
  }

  const roots = [...byBase.entries()]
    .map(([relativePath, recursive]) => ({ relativePath, recursive }))
    .sort((left, right) => left.relativePath.length - right.relativePath.length);
  return roots.filter((root, index) =>
    !roots.slice(0, index).some((parent) =>
      parent.recursive && (
        parent.relativePath === "" ||
        root.relativePath === parent.relativePath ||
        root.relativePath.startsWith(`${parent.relativePath}/`)
      )
    )
  );
}

export async function readCorpusState(runtime: BoardRuntime): Promise<CorpusState> {
  const documents = await planningDocuments(runtime);
  const allowedFiles = await planningGitAllowlist(
    runtime,
    new Set(documents.map((document) => document.path)),
  );
  const git = await gitFingerprint(runtime, allowedFiles);
  return { corpus: revisionOf(documents), git };
}

export function watchCorpus(runtime: BoardRuntime, options: WatchOptions = {}): CorpusWatcher {
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const listeners = new Set<(state: CorpusState) => void>();
  let documentWatchers: FSWatcher[] = [];
  const gitWatchers: FSWatcher[] = [];
  let last: CorpusState | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let reading = false;
  let againAfterRead = false;
  let readRetryMs = WATCH_RETRY_MS;
  let rebuilding = false;
  let rebuildQueued = false;

  const publish = (next: CorpusState): void => {
    if (closed) return;
    const previous = last;
    last = next;
    if (previous !== null && next.corpus === previous.corpus && next.git === previous.git) return;
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
      .then((next) => {
        readRetryMs = WATCH_RETRY_MS;
        publish(next);
      }, () => {
        if (closed) return;
        timer = setTimeout(settle, readRetryMs);
        readRetryMs = Math.min(readRetryMs * 2, WATCH_RETRY_MAX_MS);
      })
      .finally(() => {
        reading = false;
        if (!againAfterRead || closed) return;
        againAfterRead = false;
        if (timer) clearTimeout(timer);
        timer = null;
        settle();
      });
  };

  const bump = (): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(settle, debounceMs);
  };

  let rebuildDocumentWatchers = async (): Promise<void> => undefined;
  const scheduleRebuild = (delay = 0): void => {
    if (closed) return;
    if (rebuildTimer) {
      if (delay > 0) return;
      clearTimeout(rebuildTimer);
    }
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      void rebuildDocumentWatchers().catch(() => scheduleRebuild(WATCH_RETRY_MS));
    }, delay);
  };

  const attachDocumentRoot = async (
    root: DocumentWatchRoot,
    attached: Set<string>,
    nextWatchers: FSWatcher[],
  ): Promise<boolean> => {
    let relativePath = root.relativePath;
    let recursive = root.recursive;
    while (true) {
      try {
        const directory = await assertSafeRepositoryDirectory(runtime.repositoryRoot, relativePath);
        const key = `${directory}\0${String(recursive)}`;
        if (attached.has(key)) return true;
        const before = await lstat(directory);
        if (before.isSymbolicLink() || !before.isDirectory()) {
          throw new Error("watch path changed before attachment");
        }
        const watcher = watch(directory, { recursive }, (eventType, name) => {
          const eventPath = name === null || name === undefined
            ? null
            : String(name).replaceAll("\\", "/");
          if (eventPath === ".git" || eventPath?.startsWith(".git/")) return;
          if (eventType === "change" && eventPath && !eventPath.toLowerCase().endsWith(".md")) {
            return;
          }
          bump();
          if (eventType === "rename" && (!eventPath || !eventPath.toLowerCase().endsWith(".md"))) {
            scheduleRebuild();
          }
        });
        try {
          const after = await lstat(directory);
          if (
            after.isSymbolicLink() ||
            !after.isDirectory() ||
            after.dev !== before.dev ||
            after.ino !== before.ino
          ) {
            throw new Error("watch path changed during attachment");
          }
        } catch (error) {
          watcher.close();
          throw error;
        }
        watcher.on("error", () => {
          bump();
          scheduleRebuild(WATCH_RETRY_MS);
        });
        attached.add(key);
        nextWatchers.push(watcher);
        return true;
      } catch {
        if (relativePath === "") return false;
        const parent = path.posix.dirname(relativePath);
        relativePath = parent === "." ? "" : parent;
        recursive = true;
      }
    }
  };

  rebuildDocumentWatchers = async (): Promise<void> => {
    if (closed) return;
    if (rebuilding) {
      rebuildQueued = true;
      return;
    }
    rebuilding = true;
    const nextWatchers: FSWatcher[] = [];
    try {
      const attached = new Set<string>();
      let allAttached = true;
      for (const root of documentWatchRoots(runtime)) {
        allAttached = await attachDocumentRoot(root, attached, nextWatchers) && allAttached;
      }
      if (closed) {
        for (const watcher of nextWatchers) watcher.close();
        return;
      }
      if (nextWatchers.length === 0) {
        scheduleRebuild(WATCH_RETRY_MS);
        return;
      }
      const previous = documentWatchers;
      documentWatchers = nextWatchers;
      for (const watcher of previous) watcher.close();
      bump();
      if (!allAttached) scheduleRebuild(WATCH_RETRY_MS);
    } finally {
      rebuilding = false;
      if (rebuildQueued) {
        rebuildQueued = false;
        scheduleRebuild();
      }
    }
  };

  const attachGit = (directory: string, accept: (name: string) => boolean): void => {
    try {
      const watcher = watch(directory, (_event, name) => {
        if (name === null || accept(String(name))) bump();
      });
      watcher.on("error", () => undefined);
      gitWatchers.push(watcher);
    } catch {
      // Live Git refresh is best-effort when the filesystem cannot be watched.
    }
  };

  void rebuildDocumentWatchers().catch(() => scheduleRebuild(WATCH_RETRY_MS));
  attachGit(runtime.gitDirectory, (name) => GIT_FILES.has(name));
  settle();

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (last !== null) listener(last);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      if (rebuildTimer) clearTimeout(rebuildTimer);
      timer = null;
      rebuildTimer = null;
      listeners.clear();
      for (const watcher of [...documentWatchers, ...gitWatchers]) watcher.close();
      documentWatchers.length = 0;
      gitWatchers.length = 0;
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
