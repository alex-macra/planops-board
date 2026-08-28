import type { JSX } from "react";
import { useMemo } from "react";

import type { Board, LastChange, Task, Workflow } from "../api.ts";
import { Pill } from "../components/Pill.tsx";
import { statusTone } from "../components/tone.ts";
import { buildNow, STALE_DAYS, type NowGroup, type NowRow } from "../now.ts";

interface Props {
  readonly board: Board;
  readonly tasks: readonly Task[];
  readonly lastChanged: Readonly<Record<string, LastChange>>;
  readonly onSelectTask: (taskId: string) => void;
  readonly onOpenBacklog: () => void;
}

function Row({ row, workflow, onSelect }: { row: NowRow; workflow: Workflow; onSelect: () => void }): JSX.Element {
  const { task } = row;
  return (
    <button type="button" className="now-row focus-ring" onClick={onSelect}>
      <span className="now-row-id">{task.id}</span>
      <span className={`now-row-priority ${task.priority === workflow.priorityOrder[0] ? "text-[rgb(var(--tone-blocked))]" : ""}`}>
        {task.priority ?? ""}
      </span>
      <span className="now-row-what">{task.title ?? task.outcome ?? task.id}</span>
      <span className="now-row-side">
        {row.note ? <span className="truncate">{row.note}</span> : null}
        <Pill tone={statusTone(task.statusBase, workflow)}>{task.statusBase ?? "no status"}</Pill>
      </span>
    </button>
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
  onSelectTask,
}: {
  group: NowGroup;
  workflow: Workflow;
  onSelectTask: (taskId: string) => void;
}): JSX.Element {
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
          <Row key={row.task.id} row={row} workflow={workflow} onSelect={() => onSelectTask(row.task.id)} />
        ))}
      </div>
      {tail.length > 0 ? (
        <details>
          <summary className="focus-ring cursor-pointer border-t border-ui-border/60 px-3.5 py-2 text-xs text-ui-text-subtle hover:text-ui-text">
            Show {tail.length} more
          </summary>
          <div>
            {tail.map((row) => (
              <Row key={row.task.id} row={row} workflow={workflow} onSelect={() => onSelectTask(row.task.id)} />
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
}: Props): JSX.Element {
  const now = useMemo(() => buildNow(board, tasks, lastChanged), [board, tasks, lastChanged]);

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
        <Group key={group.id} group={group} workflow={board.workflow} onSelectTask={onSelectTask} />
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
