import { DataTable, type Column } from "../ui/index.tsx";
import { GripVertical } from "lucide-react";
import type { JSX } from "react";
import { useCallback, useMemo } from "react";

import type { Board, LastChange, Task, Workflow } from "../api.ts";
import { age, daysSince, isoDay } from "../components/relative.ts";
import { StatusTag, Tag } from "../components/Tag.tsx";
import { priorityTone, statusTone } from "../components/tone.ts";
import { rowData, type RowDragData } from "../dnd/data.ts";
import { useAutoScroll, useReorderableRow, type Edge } from "../dnd/hooks.ts";
import { comparePriority } from "../priority.ts";

interface Props {
  readonly board: Board;
  readonly tasks: readonly Task[];
  readonly onSelectTask: (taskId: string) => void;
  readonly onReorder: (task: Task, toLine: number) => void;
  /** Reordering is only meaningful when one epic's own table order is visible. */
  readonly reorderable: boolean;
  readonly lastChanged: Readonly<Record<string, LastChange>>;
}

interface Row {
  readonly id: string;
  readonly task: Task;
  readonly title: string;
  /** Days since the last commit that moved this row; Infinity when never. */
  readonly changedDays: number;
  readonly changedDate: string | null;
  readonly changedSubject: string | null;
  readonly priority: string;
  readonly status: string;
  readonly project: string;
  readonly epic: string;
  readonly owners: string;
  readonly dependencies: string;
  readonly outcome: string;
}

/**
 * `moveRow` splices the line out and reinserts it at `toLine`, so the line to
 * send depends on the direction of travel: dropping below a row that is above you
 * is not the same edit as dropping below one that is below you. Returning null
 * means the row is already there.
 */
export function targetLine(fromLine: number, overLine: number, edge: Edge): number | null {
  if (fromLine === overLine) return null;
  const line =
    fromLine > overLine
      ? edge === "top"
        ? overLine
        : overLine + 1
      : edge === "bottom"
        ? overLine
        : overLine - 1;
  return line === fromLine ? null : line;
}

function ReorderRow({
  task,
  workflow,
  projectLabel,
  onSelectTask,
  onReorder,
}: {
  task: Task;
  workflow: Workflow;
  projectLabel: string;
  onSelectTask: (taskId: string) => void;
  onReorder: (task: Task, toLine: number) => void;
}): JSX.Element {
  const canDrop = useCallback(
    (data: RowDragData) => data.file === task.file && data.section === task.section,
    [task.file, task.section],
  );

  const handleDrop = useCallback(
    (data: RowDragData, edge: Edge) => {
      const line = targetLine(data.line, task.line, edge);
      if (line !== null) onReorder({ ...task, id: data.taskId, line: data.line }, line);
    },
    [task, onReorder],
  );

  const { ref, dragging, edge } = useReorderableRow<HTMLTableRowElement>({
    data: rowData({ taskId: task.id, file: task.file, section: task.section, line: task.line }),
    canDrop,
    onDrop: handleDrop,
  });

  return (
    <tr
      ref={ref}
      className={[
        "border-b border-ui-border/60 text-xs",
        dragging ? "opacity-40" : "",
        edge === "top" ? "row-edge-top" : "",
        edge === "bottom" ? "row-edge-bottom" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-testid={`row-${task.id}`}
    >
      <td className="w-8 cursor-grab px-3 py-2 text-ui-text-subtle active:cursor-grabbing">
        <GripVertical size={14} aria-hidden />
      </td>
      <td className="px-3 py-2">
        <button
          type="button"
          className="mono whitespace-nowrap text-xs text-ui-accent hover:underline"
          onClick={() => onSelectTask(task.id)}
        >
          {task.id}
        </button>
      </td>
      <td className="px-3 py-2">
        {task.priority ? (
          <Tag tone={priorityTone(task.priority, workflow.priorityOrder)}>{task.priority}</Tag>
        ) : (
          <span className="text-ui-text-subtle">-</span>
        )}
      </td>
      <td className="px-3 py-2" title={task.status}>
        <StatusTag tone={statusTone(task.statusBase, workflow)}>{task.statusBase ?? "-"}</StatusTag>
      </td>
      <td className="px-3 py-2">{projectLabel}</td>
      <td className="px-3 py-2 text-ui-text-muted">
        <span className="line-clamp-2">{task.outcome}</span>
      </td>
    </tr>
  );
}

export function Backlog({
  board,
  tasks,
  onSelectTask,
  onReorder,
  reorderable,
  lastChanged,
}: Props): JSX.Element {
  const labelOf = useCallback(
    (id: string) => board.projects.find((project) => project.id === id)?.label ?? id,
    [board],
  );

  const rows = useMemo<Row[]>(
    () =>
      [...tasks].sort((a, b) => comparePriority(a, b, board.workflow.priorityOrder)).map((task) => {
        const changed = lastChanged[task.id];
        return {
        id: task.id,
        task,
        title: task.title ?? "",
        // Never-changed rows sort last under either direction of "oldest
        // first", which is where an unknown belongs.
        changedDays: changed ? daysSince(changed.date) : Number.POSITIVE_INFINITY,
        changedDate: changed?.date ?? null,
        changedSubject: changed?.subject ?? null,
        priority: task.priority ?? "",
        status: task.statusBase ?? "",
        project: labelOf(task.project),
        epic: task.epic,
        owners: task.owners.join(", "),
        dependencies: task.dependencies.map((dependency) => dependency.id).join(", "),
        outcome: task.outcome,
        };
      }),
    [board.workflow.priorityOrder, tasks, labelOf, lastChanged],
  );

  const ordered = useMemo(() => [...tasks].sort((a, b) => a.line - b.line), [tasks]);
  const scroll = useAutoScroll<HTMLDivElement>("vertical");

  const columns = useMemo<Column<Row>[]>(
    () => [
      {
        key: "id",
        header: "ID",
        sortable: true,
        width: "13rem",
        render: (_value, row) => (
          <button
            type="button"
            className="mono whitespace-nowrap text-xs text-ui-accent hover:underline"
            onClick={() => onSelectTask(row.id)}
          >
            {row.id}
          </button>
        ),
      },
      {
        key: "title",
        header: "Title",
        sortable: true,
        width: "16rem",
        render: (_value, row) =>
          row.title ? (
            <span className="text-xs text-ui-text">{row.title}</span>
          ) : (
            <span className="text-xs text-ui-text-subtle">-</span>
          ),
      },
      {
        key: "priority",
        header: "Priority",
        sortable: true,
        width: "6rem",
        render: (_value, row) =>
          row.priority ? (
            <Tag tone={priorityTone(row.priority, board.workflow.priorityOrder)}>{row.priority}</Tag>
          ) : (
            <span className="text-ui-text-subtle">-</span>
          ),
      },
      {
        key: "status",
        header: "Status",
        sortable: true,
        width: "10rem",
        render: (_value, row) => (
          <span title={row.task.status}>
            <StatusTag tone={statusTone(row.task.statusBase, board.workflow)}>{row.status || "-"}</StatusTag>
          </span>
        ),
      },
      {
        key: "project",
        header: "Project",
        sortable: true,
        width: "9rem",
        render: (_value, row) => <span className="text-xs">{row.project}</span>,
      },
      {
        key: "epic",
        header: "Epic",
        sortable: true,
        width: "14rem",
        render: (_value, row) => <span className="text-xs">{row.epic}</span>,
      },
      {
        key: "owners",
        header: "Owners",
        sortable: true,
        width: "12rem",
        render: (_value, row) => <span className="text-xs">{row.owners || "-"}</span>,
      },
      {
        key: "dependencies",
        header: "Depends on",
        width: "12rem",
        render: (_value, row) => (
          <span className="mono text-[11px] text-ui-text-subtle">{row.dependencies || "-"}</span>
        ),
      },
      {
        key: "changedDays",
        header: "Changed",
        sortable: true,
        width: "6rem",
        render: (_value, row) => (
          <span
            className="tabular text-xs text-ui-text-subtle"
            title={
              row.changedDate
                ? `${isoDay(row.changedDate)}${row.changedSubject ? ` · ${row.changedSubject}` : " · not committed"}`
                : "no commit has changed this row"
            }
          >
            {age(row.changedDate)}
          </span>
        ),
      },
      {
        key: "outcome",
        header: "Required outcome",
        render: (_value, row) => (
          <span className="line-clamp-2 text-xs text-ui-text-muted">{row.outcome}</span>
        ),
      },
    ],
    [board.workflow, onSelectTask],
  );

  return (
    <div className="space-y-2">
      <p className="tabular text-xs text-ui-text-subtle">
        {rows.length} of {board.tasks.length} tasks
        {reorderable
          ? " · in ledger order; drag a row to move it in the Markdown"
          : " · filter to a single epic to reorder ledger rows"}
      </p>

      {reorderable ? (
        // Same padding, borders and header weight as the DataTable the other
        // mode renders, so switching between them does not look like switching
        // components.
        <div
          ref={scroll}
          className="table-quiet max-h-[calc(100vh-15rem)] overflow-auto rounded-xl border border-ui-border"
        >
          <table className="w-full border-collapse">
            <thead className="sticky top-0 border-b border-ui-border bg-ui-bg-muted text-left text-ui-text-subtle">
              <tr>
                <th className="w-8 px-3 py-2" />
                <th className="px-3 py-2">ID</th>
                <th className="px-3 py-2">Priority</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Project</th>
                <th className="px-3 py-2">Required outcome</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((task) => (
                <ReorderRow
                  key={task.id}
                  task={task}
                  workflow={board.workflow}
                  projectLabel={labelOf(task.project)}
                  onSelectTask={onSelectTask}
                  onReorder={onReorder}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="table-quiet overflow-x-auto">
          <DataTable columns={columns} rows={rows} pageSize={50} emptyMessage="No matching tasks." />
        </div>
      )}
    </div>
  );
}
