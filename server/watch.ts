import { watch, type FSWatcher } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import fastGlob from "fast-glob";

import { gitFingerprint, planningGitAllowlist } from "./git.ts";
import { planningDocuments } from "./ledger/corpus.ts";
import { revisionOf } from "./ledger/model.ts";
import {
  boardRevision,
  loadQwenReadinessSource,
  QWEN_READINESS_PATH,
} from "./ledger/qwen-readiness.ts";
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
  const [source, allowedFiles] = await Promise.all([
    loadQwenReadinessSource(runtime.repositoryRoot),
    planningGitAllowlist(
      runtime,
      new Set(documents.filter((document) => document.writable !== false).map((document) => document.path)),
    ),
  ]);
  const git = await gitFingerprint(runtime, allowedFiles);
  return { corpus: boardRevision(revisionOf(documents), source), git };
}

export function watchCorpus(runtime: BoardRuntime, options: WatchOptions = {}): CorpusWatcher {
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const listeners = new Set<(state: CorpusState) => void>();
  let documentWatchers: FSWatcher[] = [];
  const metadataWatchers: FSWatcher[] = [];
  let manifestWatcher: FSWatcher | null = null;
  let last: CorpusState | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let reading = false;
  let againAfterRead = false;
  let readRetryMs = WATCH_RETRY_MS;
  let rebuilding = false;
  let rebuildQueued = false;
  let reconcilingManifest = false;
  let reconcileManifestAgain = false;
  const manifestParentName = path.dirname(QWEN_READINESS_PATH);
  const manifestParent = path.join(runtime.repositoryRoot, manifestParentName);

  const publish = (next: CorpusState): void => {
    if (closed) return;
    const previous = last;
    last = next;
    if (previous !== null && next.corpus === previous.corpus && next.git === previous.git) return;
    for (const listener of [...listeners]) {
      if (closed) break;
      listener(next);
    }
  };

  const settle = (): void => {
    timer = null;
    if (closed) return;
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

  const attach = (
    directory: string,
    accept: (name: string) => boolean,
    changed: () => void = bump,
  ): FSWatcher | null => {
    try {
      const watcher = watch(directory, (_event, name) => {
        if (name === null || accept(String(name))) changed();
      });
      watcher.on("error", () => undefined);
      return watcher;
    } catch {
      return null;
    }
  };

  const manifestParentIdentity = async () => {
    const [metadata, canonical] = await Promise.all([
      lstat(manifestParent),
      realpath(manifestParent),
    ]);
    return metadata.isDirectory() && !metadata.isSymbolicLink() && canonical === manifestParent
      ? { dev: metadata.dev, ino: metadata.ino, canonical }
      : null;
  };

  const reconcileManifest = (recoveryAllowance: 0 | 1 = 1): void => {
    if (closed) return;
    if (reconcilingManifest) {
      reconcileManifestAgain = true;
      return;
    }
    reconcilingManifest = true;
    let retryNeeded = false;
    manifestWatcher?.close();
    manifestWatcher = null;
    void manifestParentIdentity().then(async (before) => {
      if (closed || before === null) return;
      const candidate = attach(
        manifestParent,
        (name) => name === path.basename(QWEN_READINESS_PATH),
      );
      manifestWatcher = candidate;
      if (candidate === null) return;
      const after = await manifestParentIdentity().catch(() => null);
      if (closed) return;
      if (
        after === null ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.canonical !== before.canonical
      ) {
        if (manifestWatcher === candidate) {
          candidate.close();
          manifestWatcher = null;
        }
        retryNeeded = recoveryAllowance === 1;
      }
    }, () => undefined).finally(() => {
      reconcilingManifest = false;
      if (closed) return;
      bump();
      if (reconcileManifestAgain) {
        reconcileManifestAgain = false;
        reconcileManifest();
      } else if (retryNeeded) {
        reconcileManifest(0);
      }
    });
  };

  void rebuildDocumentWatchers().catch(() => scheduleRebuild(WATCH_RETRY_MS));
  const rootWatcher = attach(
    runtime.repositoryRoot,
    (name) => name === manifestParentName,
    () => {
      bump();
      reconcileManifest();
    },
  );
  if (rootWatcher) metadataWatchers.push(rootWatcher);
  const gitWatcher = attach(runtime.gitDirectory, (name) => GIT_FILES.has(name));
  if (gitWatcher) metadataWatchers.push(gitWatcher);
  reconcileManifest();
  settle();

  return {
    subscribe(listener) {
      if (closed) return () => undefined;
      listeners.add(listener);
      if (last !== null) listener(last);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      if (rebuildTimer) clearTimeout(rebuildTimer);
      timer = null;
      rebuildTimer = null;
      againAfterRead = false;
      reconcileManifestAgain = false;
      manifestWatcher?.close();
      manifestWatcher = null;
      listeners.clear();
      for (const watcher of [...documentWatchers, ...metadataWatchers]) watcher.close();
      documentWatchers.length = 0;
      metadataWatchers.length = 0;
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
