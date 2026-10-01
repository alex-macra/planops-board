import type { JSX, RefObject } from "react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Board, LastChange, Task, Workflow } from "../api.ts";
import { Pill } from "../components/Pill.tsx";
import { TaskActions } from "../components/TaskActions.tsx";
import { statusTone } from "../components/tone.ts";
import { deliverySummaryHeadline } from "../../shared/delivery-summary.ts";
import { buildNow, STALE_DAYS, type NowGroup, type NowRow } from "../now.ts";

interface Props {
  readonly board: Board;
  readonly tasks: readonly Task[];
  readonly lastChanged: Readonly<Record<string, LastChange>>;
  readonly onSelectTask: (taskId: string) => void;
  readonly onOpenBacklog: () => void;
  readonly onOpenGraph?: (taskId: string) => void;
  readonly onShowInBacklog?: (taskId: string) => void;
}

interface FocusCarry {
  readonly taskId: string;
  readonly index: number;
}

type SharedRowProps = Pick<Props, "onSelectTask" | "onOpenGraph" | "onShowInBacklog"> & {
  readonly lastChanged: Readonly<Record<string, LastChange>>;
  readonly carry: RefObject<FocusCarry | null>;
  readonly onMenuOpenChange: (taskId: string, change: LastChange | undefined, open: boolean) => void;
};

function Row({ row, workflow, lastChanged, carry, onMenuOpenChange, onSelectTask, onOpenGraph, onShowInBacklog }: { row: NowRow; workflow: Workflow } & SharedRowProps): JSX.Element {
  const { task } = row;
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const pending = carry.current;
    if (pending?.taskId === task.id && (document.activeElement === null || document.activeElement === document.body)) {
      const tail = element.closest("details");
      if (tail) tail.open = true;
      element.querySelectorAll("button")[pending.index]?.focus();
    }
    // Layout cleanup runs while the old row is still in the DOM, so a row that
    // regroups can see its own focus and hand it to its remount.
    return () => {
      const index = [...element.querySelectorAll("button")].findIndex((button) => button === document.activeElement);
      if (index >= 0) carry.current = { taskId: task.id, index };
    };
  }, [carry, task.id]);

  return (
    <div ref={ref} className="now-task-row">
      <button type="button" className="now-row focus-ring" onClick={() => onSelectTask(task.id)}>
        <span className="now-row-id">{task.id}</span>
        <span className={`now-row-priority ${task.priority === workflow.priorityOrder[0] ? "text-[rgb(var(--tone-blocked))]" : ""}`}>
          {task.priority ?? ""}
        </span>
        <span className="now-row-what">{task.title ?? task.outcome ?? task.id}</span>
        <span className="now-row-side">
          {row.note ? <span className="truncate">{row.note}</span> : null}
          <Pill tone={statusTone(task.statusBase, workflow)}>{task.statusBase ?? "no status"}</Pill>
        </span>
        {task.deliverySummary ? (
          <span className="now-row-delivery" title={`${deliverySummaryHeadline(task.deliverySummary)} · Next gate: ${task.deliverySummary.nextGate ?? "none recorded"}`}>
            <span className="now-row-delivery-label">Delivery</span>{" · "}{deliverySummaryHeadline(task.deliverySummary)}{" · Next: "}{task.deliverySummary.nextGate ?? "none recorded"}
          </span>
        ) : null}
      </button>
      <TaskActions taskId={task.id} onOpenDetails={() => onSelectTask(task.id)}
        onOpenGraph={onOpenGraph && (() => onOpenGraph(task.id))}
        onShowInBacklog={onShowInBacklog && (() => onShowInBacklog(task.id))}
        onMenuOpenChange={(open) => onMenuOpenChange(task.id, lastChanged[task.id], open)} />
    </div>
  );
}

/**
 * How many rows a group shows before folding. Twelve is roughly a screen; past
 * that a "queue" is a backlog again. The remainder is always stated, never
 * silently dropped.
 */
const VISIBLE = 12;

function Group({
  group,
  workflow,
  ...navigation
}: {
  group: NowGroup;
  workflow: Workflow;
} & SharedRowProps): JSX.Element {
  const head = group.rows.slice(0, VISIBLE);
  const tail = group.rows.slice(VISIBLE);
  return (
    <section className="now-group">
      <div className="now-group-head">
        <h2>{group.label}</h2>
        <p className="now-group-rule">{group.rule}</p>
        <span className="now-group-count">{group.rows.length}</span>
      </div>
      <div>
        {head.map((row) => (
          <Row key={row.task.id} row={row} workflow={workflow} {...navigation} />
        ))}
      </div>
      {tail.length > 0 ? (
        <details>
          <summary className="focus-ring cursor-pointer border-t border-ui-border/60 px-3.5 py-2 text-xs text-ui-text-subtle hover:text-ui-text">
            Show {tail.length} more
          </summary>
          <div>
            {tail.map((row) => (
              <Row key={row.task.id} row={row} workflow={workflow} {...navigation} />
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

export function Now({
  board,
  tasks,
  lastChanged,
  onSelectTask,
  onOpenBacklog,
  onOpenGraph,
  onShowInBacklog,
}: Props): JSX.Element {
  const [held, setHeld] = useState<ReadonlyMap<string, LastChange | undefined>>(new Map());
  const carry = useRef<FocusCarry | null>(null);
  const shown = useMemo(() => {
    if ([...held].every(([taskId, change]) => lastChanged[taskId] === change)) return lastChanged;
    const next: Record<string, LastChange> = { ...lastChanged };
    for (const [taskId, change] of held) {
      if (change) next[taskId] = change;
      else delete next[taskId];
    }
    return next;
  }, [lastChanged, held]);
  const now = useMemo(() => buildNow(board, tasks, shown), [board, tasks, shown]);
  const onMenuOpenChange = useCallback((taskId: string, change: LastChange | undefined, open: boolean) => {
    setHeld((current) => {
      if (open === current.has(taskId)) return current;
      const next = new Map(current);
      if (open) next.set(taskId, change);
      else next.delete(taskId);
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    carry.current = null;
  });

  return (
    <div className="space-y-4">
      <div className="rollup-context">
        <p>
          {now.shown} of {now.total} rows. Each task appears once in the highest-ranked group that
          applies.
        </p>
        {!now.historyReady ? (
          <p>Reading git for the stale group…</p>
        ) : null}
      </div>

      {now.groups.map((group) => (
        <Group key={group.id} group={group} workflow={board.workflow} lastChanged={shown} carry={carry} onMenuOpenChange={onMenuOpenChange}
          onSelectTask={onSelectTask} onOpenGraph={onOpenGraph} onShowInBacklog={onShowInBacklog} />
      ))}

      {now.groups.length === 0 ? (
        <p className="text-sm text-ui-text-muted">
          Nothing is startable, active, or going stale in this scope. That is either very good
          news or a filter that is too narrow.
        </p>
      ) : null}

      <div className="now-folded">
        <b>Folded away:</b>
        {now.folded.map((reason, index) => (
          <span key={reason.key}>
            {index > 0 ? <span aria-hidden="true">· </span> : null}
            <span className="tabular">{reason.count}</span> {reason.label}
          </span>
        ))}
        <button
          type="button"
          className="focus-ring ml-auto text-ui-accent hover:underline"
          onClick={onOpenBacklog}
        >
          Open the full backlog
        </button>
      </div>

      {now.parked.map((project) => (
        <p className="now-parked" key={project.id}>
          <b className="font-semibold text-ui-text-muted">{project.label}</b>
          <span>parked {project.parked?.since}</span>
          <span>·</span>
          <span>{project.parked?.reason}</span>
        </p>
      ))}

      <p className="text-xs leading-relaxed text-ui-text-subtle">
        Git history supplies the activity age; the Markdown ledger does not store it. Tasks become
        stale after {STALE_DAYS} days.
      </p>
    </div>
  );
}
