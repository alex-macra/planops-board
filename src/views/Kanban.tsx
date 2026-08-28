import { ConfirmDialog, DropdownMenu, EmptyState } from "../ui/index.tsx";
import { ChevronDown, ChevronRight, MoreHorizontal } from "lucide-react";
import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { Board, Task, Workflow } from "../api.ts";
import { detailOf, vocabularyOf } from "../api.ts";
import { StatusTag, Tag } from "../components/Tag.tsx";
import { priorityTone, statusRailTone, statusTone } from "../components/tone.ts";
import { cardData, type CardDragData } from "../dnd/data.ts";
import {
  useAutoScroll,
  useCardDragActive,
  useCardDropZone,
  useDraggableElement,
} from "../dnd/hooks.ts";
import { comparePriority } from "../priority.ts";
import type { GroupBy } from "../state.ts";

interface Props {
  readonly board: Board;
  readonly tasks: readonly Task[];
  readonly groupBy: GroupBy;
  readonly pendingIds: ReadonlySet<string>;
  readonly selectedId: string | null;
  readonly onSelectTask: (taskId: string | null) => void;
  readonly onMoveStatus: (task: Task, status: string) => void;
  readonly onOverlayChange?: (open: boolean) => void;
  readonly editable: boolean;
}

/** How many items the row's detail block records under one label. */
function countField(board: Board, task: Task, label: string): number {
  const fields = detailOf(board, task.id)?.fields ?? [];
  return fields
    .filter((field) => field.label === label)
    .reduce((total, field) => total + field.items.length, 0);
}

/**
 * Columns and the keyboard move must agree on what "the next state" is, so both
 * read the configured workflow order and append document-local states.
 */
function orderBases(bases: readonly string[], workflow: Workflow): string[] {
  const present = new Set(bases);
  return [
    ...workflow.statusOrder.filter((base) => present.has(base)),
    ...[...present].filter((base) => !workflow.statusOrder.includes(base)).sort(),
  ];
}

const COLLAPSED_KEY = "board.columns.collapsed";

function loadCollapsed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

interface PendingMove {
  readonly task: Task;
  readonly base: string;
}


function TaskCard({
  task,
  workflow,
  bases,
  criteria,
  notes,
  saving,
  selected,
  testId,
  onSelect,
  onMove,
  editable,
}: {
  task: Task;
  workflow: Workflow;
  bases: readonly string[];
  criteria: number;
  notes: number;
  saving: boolean;
  selected: boolean;
  testId: string;
  onSelect: () => void;
  onMove: (base: string) => void;
  editable: boolean;
}): JSX.Element {
  const { ref, dragging } = useDraggableElement<HTMLButtonElement>({
    data: cardData({ taskId: task.id, from: task.statusBase, allowed: bases }),
    canDrag: editable && task.statusCell !== null,
    previewClass: "dnd-preview",
  });

  // Native drag is not keyboard-operable, so every move has a second route:
  // bracket keys on the focused card, and an explicit menu.
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect();
      return;
    }
    if (!editable || (event.key !== "[" && event.key !== "]")) return;
    const index = task.statusBase ? bases.indexOf(task.statusBase) : -1;
    const next = bases[index + (event.key === "]" ? 1 : -1)];
    if (index !== -1 && next) {
      event.preventDefault();
      onMove(next);
    }
  };

  return (
    <div
      className={[
        "board-card-wrapper group",
        dragging ? "board-card-dragging" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        ref={ref}
        type="button"
        data-testid={testId}
        title={task.outcome}
        onKeyDown={onKeyDown}
        onClick={onSelect}
        aria-label={`Open ${task.id}: ${task.title ?? task.outcome}. ${task.statusBase ?? "no status"}${task.readiness === "startable" ? ", startable" : ""}`}
        className={[
          "board-card focus-ring",
          task.statusBase !== null && workflow.activeStatuses.includes(task.statusBase) ? "board-card-active" : "",
          task.readiness === "startable" ? "board-card-startable" : "",
          saving ? "board-card-saving" : "",
          selected ? "board-card-selected" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <p className="line-clamp-2 pr-5 text-[13px] leading-snug text-ui-text">
          {task.title ?? task.outcome}
        </p>
        <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ui-text-subtle">
          <span className="mono">{task.id}</span>
          {task.priority ? <Tag tone={priorityTone(task.priority, workflow.priorityOrder)}>{task.priority}</Tag> : null}
          {task.repositories.slice(0, 1).map((repository) => (
            <span key={repository} className="truncate">
              {repository}
            </span>
          ))}
          {task.repositories.length > 1 ? (
            <span title={task.repositories.join(", ")}>+{task.repositories.length - 1}</span>
          ) : null}
          {criteria > 0 ? (
            <span title={`${criteria} acceptance criteria`} className="tabular">
              ✓{criteria}
            </span>
          ) : null}
          {notes > 0 ? (
            <span title={`${notes} note${notes === 1 ? "" : "s"}`} className="tabular">
              ✎{notes}
            </span>
          ) : null}
          {task.statusQualifier ? <span title={task.statusQualifier}>· qualified</span> : null}
        </span>
      </button>
      {editable && task.statusCell ? (
        <span className="board-card-menu opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <DropdownMenu
            align="end"
            trigger={
              <span
                className="focus-ring rounded p-0.5 text-ui-text-subtle hover:bg-ui-bg-muted"
                aria-label={`Move ${task.id}`}
              >
                <MoreHorizontal size={14} />
              </span>
            }
            groups={[
              {
                label: "Move to",
                items: bases.map((base) => ({
                  id: base,
                  label: base,
                  disabled: base === task.statusBase,
                  onClick: () => onMove(base),
                })),
              },
            ]}
          />
        </span>
      ) : null}
    </div>
  );
}


function Column({
  base,
  tasks,
  collapsed,
  dragActive,
  board,
  pendingIds,
  selectedId,
  testIdScope,
  onToggle,
  onSelectTask,
  onDrop,
  onMove,
  editable,
}: {
  base: string;
  tasks: readonly Task[];
  collapsed: boolean;
  dragActive: boolean;
  board: Board;
  pendingIds: ReadonlySet<string>;
  selectedId: string | null;
  /** Swimlanes repeat every column and can repeat a card, so test ids are scoped. */
  testIdScope: string;
  onToggle: () => void;
  onSelectTask: (taskId: string) => void;
  onDrop: (data: CardDragData) => void;
  onMove: (task: Task, base: string) => void;
  editable: boolean;
}): JSX.Element {
  const canDrop = useCallback(
    (data: CardDragData) => editable && data.allowed.includes(base) && data.from !== base,
    [base, editable],
  );
  const { ref, state } = useCardDropZone<HTMLElement>({ canDrop, onDrop });
  const body = useAutoScroll<HTMLDivElement>("vertical");

  // Hovering a rail mid-drag opens it, so a collapsed column is never a
  // dead end when you realise you need to see what is in it.
  const [peek, setPeek] = useState(false);
  useEffect(() => {
    if (!dragActive) setPeek(false);
  }, [dragActive]);
  useEffect(() => {
    if (state !== "over" || !collapsed) return;
    const timer = window.setTimeout(() => setPeek(true), 600);
    return () => window.clearTimeout(timer);
  }, [state, collapsed]);

  const shown = collapsed && !peek;

  return (
    <section
      ref={ref}
      className={`board-column ${shown ? "board-column-rail" : ""} ${board.workflow.activeStatuses.includes(base) ? "board-column-active" : ""} board-column-${state}`}
      data-testid={`column-${testIdScope}${base}`}
    >
      <header className="board-column-header">
        <button
          type="button"
          className="focus-ring flex items-center gap-1.5 overflow-hidden rounded"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${base}`}
        >
          {shown ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          {shown ? (
            // A rail is only ~3rem wide, so the label reads bottom-to-top rather
            // than being clipped or spilling over its neighbour.
            <span className={`board-rail-label ${statusRailTone(base, board.workflow)}`}>{base}</span>
          ) : (
            <StatusTag tone={statusTone(base, board.workflow)}>{base}</StatusTag>
          )}
        </button>
        <span className="tabular text-xs text-ui-text-subtle">{tasks.length}</span>
      </header>

      {shown ? null : (
        <div ref={body} className="board-column-body">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              workflow={board.workflow}
              bases={orderBases(vocabularyOf(board, task), board.workflow)}
              criteria={countField(board, task, "Acceptance criteria")}
              notes={countField(board, task, "Note")}
              saving={pendingIds.has(task.id)}
              selected={selectedId === task.id}
              testId={`card-${testIdScope}${task.id}`}
              onSelect={() => onSelectTask(task.id)}
              onMove={(next) => onMove(task, next)}
              editable={editable}
            />
          ))}
          {/* Only while something is in the air: nine dashed boxes standing
            * there at rest was most of the noise on an idle board. */}
          {tasks.length === 0 && dragActive ? (
            <p className="board-column-empty">Drop here</p>
          ) : null}
        </div>
      )}
    </section>
  );
}


interface Lane {
  readonly key: string;
  readonly label: string;
  readonly tasks: readonly Task[];
}

function laneOf(task: Task, groupBy: GroupBy): string[] {
  if (groupBy === "project") return [task.project];
  if (groupBy === "epic") return [task.file];
  if (groupBy === "repository") return task.repositories.length ? [...task.repositories] : ["-"];
  return ["all"];
}

export function Kanban({
  board,
  tasks,
  groupBy,
  pendingIds,
  selectedId,
  onSelectTask,
  onMoveStatus,
  onOverlayChange,
  editable,
}: Props): JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [pendingConfirm, setPendingConfirm] = useState<PendingMove | null>(null);
  const [closedLanes, setClosedLanes] = useState<ReadonlySet<string>>(new Set());
  const dragActive = useCardDragActive();
  const track = useAutoScroll<HTMLDivElement>("horizontal");

  useEffect(() => {
    onOverlayChange?.(pendingConfirm !== null);
    return () => onOverlayChange?.(false);
  }, [onOverlayChange, pendingConfirm]);

  const bases = useMemo(
    () => orderBases(board.documents.flatMap((document) => document.vocabulary.bases), board.workflow),
    [board],
  );

  const labelOf = useCallback(
    (key: string): string => {
      if (groupBy === "project") {
        return board.projects.find((project) => project.id === key)?.label ?? key;
      }
      if (groupBy === "epic") {
        return board.documents.find((document) => document.path === key)?.title ?? key;
      }
      return key;
    },
    [board, groupBy],
  );

  const lanes = useMemo<Lane[]>(() => {
    if (groupBy === "none") return [{ key: "all", label: "", tasks }];
    const buckets = new Map<string, Task[]>();
    for (const task of tasks) {
      for (const key of laneOf(task, groupBy)) {
        const bucket = buckets.get(key);
        if (bucket) bucket.push(task);
        else buckets.set(key, [task]);
      }
    }
    return [...buckets.entries()]
      .map(([key, laneTasks]) => ({ key, label: labelOf(key), tasks: laneTasks }))
      .sort((a, b) => b.tasks.length - a.tasks.length);
  }, [tasks, groupBy, labelOf]);

  const toggleColumn = useCallback((base: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(base)) next.delete(base);
      else next.add(base);
      window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  const requestMove = useCallback(
    (task: Task, base: string) => {
      if (task.statusBase === base) return;
      // A qualifier records *why* a row is in its current state, so it cannot
      // survive a state change unreviewed. Confirm before discarding it.
      if (task.statusQualifier) {
        setPendingConfirm({ task, base });
        return;
      }
      // Announcing is the caller's job: it is the only side that knows whether
      // the validator accepted the move.
      onMoveStatus(task, base);
    },
    [onMoveStatus],
  );

  const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const unstated = tasks.filter((task) => task.statusBase === null);

  return (
    <>
      <div ref={track} className="board-track" data-testid="kanban">
        {lanes.map((lane) => {
          const laneClosed = closedLanes.has(lane.key);
          // Swimlanes repeat columns and cards, so test IDs are qualified by lane.
          const testIdScope = groupBy === "none" ? "" : `${lane.key}-`;
          return (
            <div key={lane.key} className="board-lane">
              {groupBy === "none" ? null : (
                <button
                  type="button"
                  className="board-lane-header focus-ring"
                  onClick={() =>
                    setClosedLanes((current) => {
                      const next = new Set(current);
                      if (next.has(lane.key)) next.delete(lane.key);
                      else next.add(lane.key);
                      return next;
                    })
                  }
                  aria-expanded={!laneClosed}
                >
                  {laneClosed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  <span className="font-medium">{lane.label}</span>
                  <span className="tabular text-ui-text-subtle">{lane.tasks.length}</span>
                </button>
              )}

              {laneClosed ? null : (
                <div className="board-columns">
                  {bases.map((base) => (
                    <Column
                      key={base}
                      base={base}
                      board={board}
                      collapsed={collapsed.has(base)}
                      dragActive={dragActive}
                      pendingIds={pendingIds}
                      selectedId={selectedId}
                      testIdScope={testIdScope}
                      tasks={lane.tasks
                        .filter((task) => task.statusBase === base)
                        .sort((a, b) => comparePriority(a, b, board.workflow.priorityOrder))}
                      onToggle={() => toggleColumn(base)}
                      onSelectTask={onSelectTask}
                      onMove={requestMove}
                      editable={editable}
                      onDrop={(data) => {
                        const task = byId.get(data.taskId);
                        if (task) requestMove(task, base);
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {tasks.length === 0 ? (
        <EmptyState title="No tasks match these filters" description="Clear a filter to see more." />
      ) : null}

      {unstated.length > 0 ? (
        <p className="mt-3 text-xs text-ui-text-subtle">
          {unstated.length} row(s) come from tables without a Status column (decision and question
          registers) and are not shown on the board.
        </p>
      ) : null}

      <ConfirmDialog
        open={pendingConfirm !== null}
        title={`Move ${pendingConfirm?.task.id ?? ""} to ${pendingConfirm?.base ?? ""}?`}
        description={
          <>
            This drops the qualifier{" "}
            <span className="mono">“{pendingConfirm?.task.statusQualifier}”</span>. Use the detail
            panel instead if you want to keep it.
          </>
        }
        confirmLabel="Move and drop qualifier"
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => {
          const move = pendingConfirm;
          setPendingConfirm(null);
          if (move) onMoveStatus(move.task, move.base);
        }}
      />
    </>
  );
}
