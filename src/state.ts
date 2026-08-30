import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  addNote,
  ApiError,
  documentShaOf,
  fetchBoard,
  fetchGitStatus,
  fetchLastChanged,
  moveRow as moveRowRequest,
  writeCell,
  type Board,
  type BoardSession,
  type CellRef,
  type CorpusState,
  type GitStatusResponse,
  type LastChange,
  type Readiness,
  type Task,
  type Workflow,
} from "./api.ts";
import { useCorpusEvents, type LiveStatus } from "./live.ts";
import { comparePriority } from "./priority.ts";
import { stamped } from "../shared/stamp.ts";
import { parseStatusValue } from "../shared/status.ts";

export type GroupBy = "none" | "project" | "epic" | "repository";

export interface Filters {
  readonly text: string;
  /** Project scope applied consistently across every view. */
  readonly project: string;
  readonly epic: string;
  readonly repository: string;
  readonly priority: string;
  readonly status: string;
  readonly readiness: Exclude<Readiness, null> | "";
}

export const emptyFilters: Filters = {
  text: "",
  project: "",
  epic: "",
  repository: "",
  priority: "",
  status: "",
  readiness: "",
};

/**
 * Whether a project's scope contains this row.
 *
 * A cross-project row is reachable from every project it touches and from its
 * own lane, so shared work remains visible under each relevant scope.
 */
export function touchesProject(
  task: { readonly project: string; readonly projects: readonly string[] },
  project: string,
): boolean {
  return task.project === project || task.projects.includes(project);
}

export function filterTasks(tasks: readonly Task[], filters: Filters, workflow: Workflow): Task[] {
  const needle = filters.text.trim().toLowerCase();
  return tasks.filter((task) => {
    if (filters.project && !touchesProject(task, filters.project)) return false;
    if (filters.epic && task.file !== filters.epic) return false;
    if (filters.repository && !task.repositories.includes(filters.repository)) return false;
    if (filters.priority && task.priority !== filters.priority) return false;
    if (
      filters.status &&
      (filters.status === "active"
        ? task.statusBase === null || !workflow.activeStatuses.includes(task.statusBase)
        : task.statusBase !== filters.status)
    ) return false;
    if (filters.readiness && task.readiness !== filters.readiness) return false;
    if (!needle) return true;
    return (
      task.id.toLowerCase().includes(needle) ||
      task.outcome.toLowerCase().includes(needle) ||
      task.epic.toLowerCase().includes(needle) ||
      task.owners.some((owner) => owner.toLowerCase().includes(needle))
    );
  });
}

export interface PendingMove {
  readonly status: string;
  readonly statusBase: string | null;
  readonly statusQualifier: string;
  /**
   * Which write owns this entry. Two moves of the same card overlap: the first
   * write completes while the second is still in flight, and clearing the key
   * unconditionally would drop the second card's overlay; it springs back to the
   * column it just left, which looks exactly like a rejected write.
   */
  readonly token: number;
}

/**
 * Overlay a card's new column on top of the server's payload.
 *
 * `board` deliberately stays byte-faithful to what the server returned: a write
 * is guarded by the document digest *and* the value the client believes is in the
 * cell, so inventing either locally would defeat the guard that makes a browser
 * tab racing another writer safe. The optimistic state lives here instead, and
 * only ever reaches the render path.
 */
export function applyPending(
  tasks: readonly Task[],
  pending: ReadonlyMap<string, PendingMove>,
): Task[] {
  if (pending.size === 0) return tasks as Task[];
  return tasks.map((task) => {
    const move = pending.get(task.id);
    if (!move) return task;
    return {
      ...task,
      status: move.status,
      statusBase: move.statusBase,
      statusQualifier: move.statusQualifier,
    };
  });
}

/**
 * Which cells a write touches. A status change writes the status and date stamp,
 * and they must revert together or an undo would
 * leave the row claiming it was set on a day it was not.
 */
export type EditableField = "status" | "priority" | "outcome";

export function cellOf(task: Task, field: EditableField): CellRef | null {
  if (field === "status") return task.statusCell;
  if (field === "priority") return task.priorityCell;
  return task.outcomeCell;
}

export function valueOf(task: Task, field: EditableField): string {
  if (field === "status") return task.status;
  if (field === "priority") return task.priority ?? "";
  return task.outcome;
}

/**
 * Every edit the board can make is undoable, not just a status move: reverting a
 * priority change or a row reorder with `Ctrl`+`Z` must not silently reach past
 * it to an older, unrelated status edit.
 */
type UndoEntry =
  | {
      readonly kind: "cells";
      readonly taskId: string;
      readonly label: string;
      /** The values to put back, by field; cells are re-resolved at undo time. */
      readonly previous: readonly { field: EditableField; value: string }[];
    }
  | {
      readonly kind: "row";
      readonly taskId: string;
      readonly label: string;
      readonly file: string;
      /**
       * `moveRow` splices the line out and reinserts it, so (to, from) is its own
       * exact inverse.
       */
      readonly fromLine: number;
      readonly toLine: number;
    };

export interface BoardState {
  readonly board: Board | null;
  readonly git: GitStatusResponse | null;
  readonly loading: boolean;
  readonly error: string | null;
  /** Task IDs edited in this session, used for the default commit message. */
  readonly touched: readonly string[];
  /** Cards showing their new column before the server has confirmed it. */
  readonly pending: ReadonlyMap<string, PendingMove>;
  readonly undoable: { readonly taskId: string; readonly label: string } | null;
  /** When each row last moved, by task ID. Empty until the summary arrives. */
  readonly lastChanged: Readonly<Record<string, LastChange>>;
  /** Whether the live channel is actually carrying anything. */
  readonly live: LiveStatus;
  /** Disk has moved and this tab has not caught up yet, because it is busy. */
  readonly behind: boolean;
  /** A guarded Markdown write is queued or running. */
  readonly writing: boolean;
  /** When a change made outside this tab was last adopted, epoch ms. */
  readonly refreshedAt: number | null;
  /** When the board source was last checked successfully, epoch ms. */
  readonly checkedAt: number | null;
  /** Resolves to whether the fetch succeeded; a failure leaves the last board up. */
  reload: () => Promise<boolean>;
  setStatus: (task: Task, status: string) => Promise<void>;
  setPriority: (task: Task, priority: string) => Promise<void>;
  moveRow: (task: Task, toLine: number) => Promise<void>;
  addNote: (task: Task, text: string, title?: string) => Promise<void>;
  undo: () => Promise<void>;
  clearTouched: () => void;
}

function messageOf(cause: unknown): string {
  if (cause instanceof ApiError) {
    return cause.failure.details
      ? `${cause.failure.error}\n${cause.failure.details}`
      : cause.failure.error;
  }
  return String(cause);
}

export interface BoardOptions {
  /**
   * Hold live refreshes. The board is handed this rather than working it out,
   * because what makes a refresh unwelcome is an interaction in progress, and
   * that is known where the interaction is.
   */
  readonly paused?: boolean;
  readonly session: BoardSession;
}

export function useBoard({ paused = false, session }: BoardOptions): BoardState {
  const [board, setBoard] = useState<Board | null>(null);
  const [git, setGit] = useState<GitStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState<string[]>([]);
  const [pending, setPending] = useState<ReadonlyMap<string, PendingMove>>(new Map());
  const [lastChanged, setLastChanged] = useState<Readonly<Record<string, LastChange>>>({});
  const [remote, setRemote] = useState<CorpusState | null>(null);
  const [writing, setWriting] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  // The undo stack is a ref first and state second. Two `Ctrl`+`Z` presses in one
  // tick share a single render's closure, so reading the top entry from state
  // returns the *same* entry twice: it is applied once, popped twice, and the
  // entry beneath it is discarded without ever being written.
  const undoRef = useRef<readonly UndoEntry[]>([]);
  const [undoStack, setUndoStack] = useState<readonly UndoEntry[]>([]);
  const putUndo = useCallback((next: readonly UndoEntry[]) => {
    undoRef.current = next;
    setUndoStack(next);
  }, []);

  // Writes read the freshest board at execution time, not at call time: a queued
  // edit must use the digest and line numbers the previous edit produced.
  const boardRef = useRef<Board | null>(null);
  boardRef.current = board;

  const reload = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    let ok = false;
    try {
      const [boardResult, nextGit] = await Promise.all([
        fetchBoard(boardRef.current?.revision),
        session.capabilities.localWrites ? fetchGitStatus() : Promise.resolve(null),
      ]);
      if (boardResult.board) {
        setBoard(boardResult.board);
        boardRef.current = boardResult.board;
      }
      setGit(nextGit);
      setError(null);
      setCheckedAt(Date.now());
      ok = true;
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.failure.error : String(cause));
    } finally {
      setLoading(false);
    }

    // Not awaited: replaying the corpus's timeline is ~600ms cold, and the board
    // is usable without it. The column reads "-" until this lands.
    void fetchLastChanged()
      .then(setLastChanged)
      .catch(() => undefined);

    return ok;
  }, [session.capabilities.localWrites]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (session.capabilities.liveEvents) return;
    let stopped = false;
    let timer = 0;
    let delay = 60_000;
    const schedule = (): void => {
      timer = window.setTimeout(() => void refresh(), delay);
    };
    const refresh = async (): Promise<void> => {
      if (stopped) return;
      if (document.visibilityState === "visible") {
        const ok = await reload();
        delay = ok ? 60_000 : Math.min(delay * 2, 5 * 60_000);
        if (ok) setRefreshedAt(Date.now());
      }
      schedule();
    };
    const onVisibility = (): void => {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    schedule();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reload, session.capabilities.liveEvents]);

  /**
   * One write at a time. Two quick drags in the same document would otherwise
   * race on a digest that the first write invalidates, turning an ordinary edit
   * into a 409 the user did not cause.
   */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  // Depth rather than a boolean: the queue is drained only when the *last*
  // enqueued job settles, and a live refresh must wait for all of them.
  const depth = useRef(0);
  const enqueue = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    depth.current += 1;
    setWriting(true);
    const run = queue.current.then(job, job);
    queue.current = run
      .catch(() => undefined)
      .finally(() => {
        depth.current -= 1;
        if (depth.current === 0) setWriting(false);
      });
    return run;
  }, []);

  const markTouched = useCallback((taskId: string) => {
    setTouched((current) => (current.includes(taskId) ? current : [...current, taskId]));
  }, []);

  /**
   * Write one or more of a row's cells, guarded exactly as a single cell was.
   *
   * `patchCells` applies the array atomically with a per-edit `expected`, so a
   * status and its stamp are one write, one validator run and one rollback;
   * the row can never carry a date for a status it does not have.
   */
  const writeFields = useCallback(
    async (taskId: string, fields: readonly { field: EditableField; value: string }[]) => {
      const current = boardRef.current;
      const task = current?.tasks.find((candidate) => candidate.id === taskId);
      if (!current || !task) throw new Error(`${taskId} is no longer on the board`);

      const previous: { field: EditableField; value: string }[] = [];
      const edits = fields.flatMap((entry) => {
        const cell = cellOf(task, entry.field);
        // A table with no outcome column simply gets
        // no stamp. A missing one must never fail the status write itself.
        if (!cell) {
          if (entry.field === "outcome") return [];
          throw new Error(`${taskId} has no editable ${entry.field} cell`);
        }
        const expected = valueOf(task, entry.field);
        previous.push({ field: entry.field, value: expected });
        return [{ cell, expected, value: entry.value }];
      });

      if (edits.length > 0) {
        await writeCell(task.file, documentShaOf(current, task.file), edits);
        markTouched(taskId);
        await reload();
      }
      return { previous };
    },
    [markTouched, reload],
  );

  const token = useRef(0);

  const setStatus = useCallback(
    async (task: Task, status: string) => {
      const currentBoard = boardRef.current;
      const bases = currentBoard?.documents.find((document) => document.path === task.file)
        ?.vocabulary.bases ?? currentBoard?.workflow.statusOrder ?? [];
      const parsedStatus = parseStatusValue(status, bases);
      const mine = (token.current += 1);
      setPending((current) =>
        new Map(current).set(task.id, {
          status,
          statusBase: parsedStatus.base ?? status,
          statusQualifier: parsedStatus.qualifier,
          token: mine,
        }),
      );

      try {
        const result = await enqueue(() =>
          writeFields(task.id, [
            { field: "status", value: status },
            { field: "outcome", value: stamped(task.outcome) },
          ]),
        );
        putUndo([
          ...undoRef.current,
          {
            kind: "cells",
            taskId: task.id,
            label: `${task.id} → ${task.status || "(empty)"}`,
            previous: result.previous,
          },
        ]);
      } finally {
        // Cleared either way: on success the reloaded board already says this.
        // Only if this write still owns the overlay; a later move may have
        // replaced it while this one was in flight.
        setPending((current) => {
          if (current.get(task.id)?.token !== mine) return current;
          const next = new Map(current);
          next.delete(task.id);
          return next;
        });
      }
    },
    [enqueue, putUndo, writeFields],
  );

  const setPriority = useCallback(
    async (task: Task, priority: string) => {
      // No stamp: the stamp says when the *status* was set, and a priority
      // change would make it lie.
      const result = await enqueue(() =>
        writeFields(task.id, [{ field: "priority", value: priority }]),
      );
      putUndo([
        ...undoRef.current,
        {
          kind: "cells",
          taskId: task.id,
          label: `${task.id} → ${task.priority || "(empty)"}`,
          previous: result.previous,
        },
      ]);
    },
    [enqueue, putUndo, writeFields],
  );

  const moveRow = useCallback(
    async (task: Task, toLine: number) => {
      await enqueue(async () => {
        const current = boardRef.current;
        if (!current) return;
        await moveRowRequest(task.file, documentShaOf(current, task.file), task.line, toLine);
        markTouched(task.id);
        await reload();
      });
      putUndo([
        ...undoRef.current,
        {
          kind: "row",
          taskId: task.id,
          label: `${task.id} → line ${task.line}`,
          file: task.file,
          fromLine: toLine,
          toLine: task.line,
        },
      ]);
    },
    [enqueue, markTouched, putUndo, reload],
  );

  /**
   * Notes are not undoable.
   *
   * `Ctrl`+`Z` reverts a *value* the board overwrote. A note adds prose that was
   * not there before, and quietly deleting a paragraph on a keystroke is a
   * different and much worse operation than putting a status back. Removing one
   * is an edit to the document, where it belongs.
   */
  const note = useCallback(
    async (task: Task, text: string, title?: string) => {
      await enqueue(async () => {
        const current = boardRef.current;
        if (!current) throw new Error("the board is not loaded");
        const block = current.details.find((candidate) => candidate.id === task.id);
        // The block is the note's home even when it lives in another document
        // than the row because heading IDs are unique across the whole corpus.
        const file = block?.file ?? task.file;
        await addNote({
          file,
          taskId: task.id,
          baseSha256: documentShaOf(current, file),
          text,
          ...(title === undefined ? {} : { title }),
        });
        markTouched(task.id);
        await reload();
      });
    },
    [enqueue, markTouched, reload],
  );

  /**
   * Undo replays through the same guarded write path because it is an ordinary
   * edit, not a privileged rewind.
   *
   * The entry is popped before the write and put back if the write is refused: a
   * rejected undo that had already dropped its entry would be unrepeatable.
   */
  const undo = useCallback(async () => {
    const entry = undoRef.current.at(-1);
    if (!entry) return;
    putUndo(undoRef.current.slice(0, -1));

    try {
      await enqueue(async () => {
        if (entry.kind === "cells") {
          // Restores the exact prior values, stamp included. Re-stamping here
          // would make an undo say the status was set today, when undoing is
          // precisely the claim that it was not.
          await writeFields(entry.taskId, entry.previous);
          return;
        }
        const current = boardRef.current;
        const task = current?.tasks.find((candidate) => candidate.id === entry.taskId);
        if (!current || !task) throw new Error(`${entry.taskId} is no longer on the board`);
        if (task.line !== entry.fromLine) {
          throw new Error(
            `${entry.taskId} has moved since; undoing would reorder the wrong row`,
          );
        }
        await moveRowRequest(
          entry.file,
          documentShaOf(current, entry.file),
          entry.fromLine,
          entry.toLine,
        );
        markTouched(entry.taskId);
        await reload();
      });
    } catch (cause) {
      putUndo([...undoRef.current, entry]);
      throw cause;
    }
  }, [enqueue, markTouched, putUndo, reload, writeFields]);

  const clearTouched = useCallback(() => {
    setTouched([]);
    putUndo([]);
  }, [putUndo]);


  const live = useCorpusEvents(setRemote, session.capabilities.liveEvents);

  /**
   * The comparison is against what this tab *holds*, never against a token it
   * issued. That is the whole trick: after a write's own reload the digests
   * already agree, so the board's own edits cost no extra fetch and need no
   * bookkeeping, while any external file or Git change reads as different on
   * the next frame.
   */
  const behind =
    remote !== null &&
    board !== null &&
    (remote.corpus !== board.revision || (git !== null && remote.git !== git.fingerprint));

  useEffect(() => {
    // A write reloads on its own, and replacing the board mid-drag unmounts the
    // card the pointer is holding. Both end by flipping a dependency here, so
    // the refresh lands the moment it stops being disruptive rather than never.
    if (!behind || writing || paused) return;
    void reload().then((ok) => {
      // Only on a fetch that landed. A failed refresh leaves the previous board
      // on screen, and stamping it "updated" would be the one lie that matters.
      if (ok) setRefreshedAt(Date.now());
    });
  }, [behind, writing, paused, reload]);

  const last = undoStack.at(-1);

  return {
    board,
    git,
    loading,
    error,
    touched,
    pending,
    undoable: last ? { taskId: last.taskId, label: last.label } : null,
    lastChanged,
    live,
    behind,
    writing,
    refreshedAt,
    checkedAt,
    reload,
    setStatus,
    setPriority,
    moveRow,
    addNote: note,
    undo,
    clearTouched,
  };
}

export { messageOf };


export interface FilterOptions {
  readonly projects: { value: string; label: string }[];
  readonly epics: { value: string; label: string }[];
  readonly repositories: { value: string; label: string }[];
  readonly priorities: { value: string; label: string }[];
  readonly statuses: { value: string; label: string }[];
}

export function useFilterOptions(board: Board | null, filters: Filters): FilterOptions {
  return useMemo(() => {
    if (!board) return { projects: [], epics: [], repositories: [], priorities: [], statuses: [] };

    // Scoping to a project should narrow the other menus too, otherwise they list
    // epics that cannot produce a single row.
    const scoped = filterTasks(board.tasks, { ...emptyFilters, project: filters.project }, board.workflow);
    const files = new Set(scoped.map((task) => task.file));
    const repositories = [...new Set(scoped.flatMap((task) => task.repositories))].sort();
    const priorities = [
      ...new Set(scoped.flatMap((task) => (task.priority ? [task.priority] : []))),
    ].sort();

    return {
      projects: [
        { value: "", label: `All projects · ${board.tasks.length}` },
        ...board.projects.map((project) => ({
          value: project.id,
          label: `${project.label} · ${project.taskCount}`,
        })),
      ],
      epics: [
        { value: "", label: "All epics" },
        ...board.documents
          .filter((document) => document.taskCount > 0 && files.has(document.path))
          .map((document) => ({ value: document.path, label: document.title })),
      ],
      repositories: [
        { value: "", label: "All repositories" },
        ...repositories.map((name) => ({ value: name, label: name })),
      ],
      priorities: [
        { value: "", label: "All priorities" },
        ...priorities.map((name) => ({ value: name, label: name })),
      ],
      statuses: [
        { value: "", label: "All statuses" },
        { value: "active", label: "Active work" },
        ...board.statusBases.map((name) => ({ value: name, label: name })),
      ],
    };
  }, [board, filters.project]);
}


export const VIEW_IDS = ["now", "stories", "rollup", "kanban", "backlog", "graph"] as const;

export type ViewId = (typeof VIEW_IDS)[number];

/**
 * Now, not Rollup.
 *
 * The default view answers what should be touched next. Every other view keeps
 * its URL exactly as it was.
 */
const DEFAULT_VIEW: ViewId = "now";

export interface BoardQuery {
  readonly view: ViewId;
  readonly group: GroupBy;
  readonly filters: Filters;
  readonly task: string | null;
  readonly story: string | null;
}

export interface BoardQueryPatch {
  readonly view?: ViewId;
  readonly group?: GroupBy;
  readonly filters?: Partial<Filters>;
  readonly task?: string | null;
  readonly story?: string | null;
}

const DEFAULT_QUERY: BoardQuery = {
  view: DEFAULT_VIEW,
  group: "none",
  filters: emptyFilters,
  task: null,
  story: null,
};

function parseHash(hash: string): BoardQuery {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const view = params.get("view");
  const group = params.get("group");
  return {
    view: VIEW_IDS.includes(view as ViewId) ? (view as ViewId) : DEFAULT_VIEW,
    group: (["none", "project", "epic", "repository"] as const).includes(group as GroupBy)
      ? (group as GroupBy)
      : "none",
    filters: {
      text: params.get("q") ?? "",
      project: params.get("project") ?? "",
      epic: params.get("epic") ?? "",
      repository: params.get("repo") ?? "",
      priority: params.get("priority") ?? "",
      status: params.get("status") ?? "",
      readiness:
        params.get("readiness") === "waiting" || params.get("readiness") === "needs-gate-check"
          ? (params.get("readiness") as Exclude<Readiness, null>)
          : params.get("readiness") === "startable" || params.get("startable") === "1"
            ? "startable"
            : "",
    },
    task: params.get("task"),
    story: params.get("story"),
  };
}

function writeHash(query: BoardQuery): string {
  const params = new URLSearchParams();
  if (query.view !== DEFAULT_VIEW) params.set("view", query.view);
  if (query.group !== "none") params.set("group", query.group);
  if (query.filters.text) params.set("q", query.filters.text);
  if (query.filters.project) params.set("project", query.filters.project);
  if (query.filters.epic) params.set("epic", query.filters.epic);
  if (query.filters.repository) params.set("repo", query.filters.repository);
  if (query.filters.priority) params.set("priority", query.filters.priority);
  if (query.filters.status) params.set("status", query.filters.status);
  if (query.filters.readiness) params.set("readiness", query.filters.readiness);
  if (query.task) params.set("task", query.task);
  if (query.story) params.set("story", query.story);
  return params.toString();
}

/**
 * View, scope, filters and the open task live in the URL so a reload keeps its
 * place and a particular slice of the board can be handed to another session.
 */
export type QueryHistory = "replace" | "push";

export function taskOnlyQuery(task: string): BoardQueryPatch {
  return {
    view: DEFAULT_VIEW,
    group: "none",
    filters: emptyFilters,
    task,
    story: null,
  };
}

export function useBoardQuery(): [BoardQuery, (next: BoardQueryPatch, history?: QueryHistory) => void] {
  const [query, setQuery] = useState<BoardQuery>(() =>
    typeof window === "undefined" ? DEFAULT_QUERY : parseHash(window.location.hash),
  );
  const current = useRef(query);

  useEffect(() => {
    const onHashChange = (): void => {
      const next = parseHash(window.location.hash);
      current.current = next;
      setQuery(next);
    };
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("popstate", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("popstate", onHashChange);
    };
  }, []);

  const update = useCallback((next: BoardQueryPatch, history: QueryHistory = "replace") => {
    const merged: BoardQuery = {
      ...current.current,
      ...next,
      filters: { ...current.current.filters, ...next.filters },
    };
    const hash = writeHash(merged);
    const url = `${window.location.pathname}${hash ? `#${hash}` : ""}`;
    if (history === "push") window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
    current.current = merged;
    setQuery(merged);
  }, []);

  return [query, update];
}
