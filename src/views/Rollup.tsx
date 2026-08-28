import type { JSX } from "react";
import { useMemo } from "react";

import type { Board, LastChange, Task, Workflow } from "../api.ts";
import { age, daysSince } from "../components/relative.ts";
import { Stat, StatRow } from "../components/Stat.tsx";
import { StatusTag } from "../components/Tag.tsx";
import { statusTone } from "../components/tone.ts";
import { touchesProject } from "../state.ts";

interface Props {
  readonly board: Board;
  readonly tasks: readonly Task[];
  readonly onOpenProject: (project: string) => void;
  readonly onOpenEpic: (file: string) => void;
  readonly onOpenRepository: (repository: string) => void;
  readonly onOpenStartable: () => void;
  readonly onSelectTask: (taskId: string) => void;
  readonly lastChanged: Readonly<Record<string, LastChange>>;
}

const STALE_DAYS = 7;

interface Group {
  readonly key: string;
  readonly label: string;
  readonly tasks: readonly Task[];
}

function openTopPriority(tasks: readonly Task[], workflow: Workflow): number {
  const top = workflow.priorityOrder[0];
  if (!top) return 0;
  return tasks.filter((task) =>
    task.priority === top && (task.statusBase === null || !workflow.closedStatuses.includes(task.statusBase)),
  ).length;
}

function GroupCard({
  group,
  workflow,
  onOpen,
}: {
  group: Group;
  workflow: Workflow;
  onOpen: () => void;
}): JSX.Element {
  const byBase = new Map<string, number>();
  for (const task of group.tasks) {
    const key = task.statusBase ?? "no status";
    byBase.set(key, (byBase.get(key) ?? 0) + 1);
  }
  const startable = group.tasks.filter((task) => task.readiness === "startable").length;
  const waiting = group.tasks.filter((task) => task.readiness === "waiting").length;
  const gates = group.tasks.filter((task) => task.readiness === "needs-gate-check").length;
  const complete = group.tasks.filter((task) =>
    task.statusBase !== null && workflow.dependencySatisfiedStatuses.includes(task.statusBase),
  ).length;
  const percent = group.tasks.length === 0 ? 0 : Math.round((complete / group.tasks.length) * 100);

  return (
    <button
      type="button"
      className="group-card focus-ring text-left"
      aria-label={group.label}
      onClick={onOpen}
    >
      <span className="group-card-heading">
        <span className="group-card-name">{group.label}</span>
        <span className="tabular shrink-0 text-xs text-ui-text-subtle" aria-hidden="true">
          {group.tasks.length} tasks
        </span>
      </span>

      <span
        className="group-card-progress"
        role="progressbar"
        aria-label={`${complete} of ${group.tasks.length} tasks complete`}
        aria-valuemin={0}
        aria-valuemax={group.tasks.length}
        aria-valuenow={complete}
      >
        <span style={{ width: `${percent}%` }} />
      </span>
      <span className="tabular group-card-summary">
        {complete} complete / {startable} startable / {waiting} waiting / {gates} gate checks
      </span>

      <span className="group-card-tones">
        {[...byBase.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([base, count]) => (
            <StatusTag key={base} tone={statusTone(base === "no status" ? null : base, workflow)}>
              {base} <span className="tabular text-ui-text-subtle">{count}</span>
            </StatusTag>
          ))}
      </span>
    </button>
  );
}

export function Rollup({
  board,
  tasks,
  onOpenProject,
  onOpenEpic,
  onOpenRepository,
  onOpenStartable,
  onSelectTask,
  lastChanged,
}: Props): JSX.Element {
  // Bucket by the same membership rule the scope filter uses so card counts
  // match the rows shown after opening a project.
  const projects = useMemo<Group[]>(
    () =>
      board.projects
        .map((project) => ({
          key: project.id,
          label: project.label,
          tasks: tasks.filter((task) => touchesProject(task, project.id)),
        }))
        .filter((group) => group.tasks.length > 0)
        .sort((a, b) => openTopPriority(b.tasks, board.workflow) - openTopPriority(a.tasks, board.workflow) || b.tasks.length - a.tasks.length),
    [board.projects, board.workflow, tasks],
  );

  const epics = useMemo<Group[]>(() => {
    const byFile = new Map<string, Task[]>();
    for (const task of tasks) {
      const bucket = byFile.get(task.file);
      if (bucket) bucket.push(task);
      else byFile.set(task.file, [task]);
    }
    return board.documents
      .filter((document) => byFile.has(document.path))
      .map((document) => ({
        key: document.path,
        label: document.title,
        tasks: byFile.get(document.path) ?? [],
      }))
      .sort((a, b) => openTopPriority(b.tasks, board.workflow) - openTopPriority(a.tasks, board.workflow) || b.tasks.length - a.tasks.length);
  }, [board.documents, board.workflow, tasks]);

  const repositories = useMemo<Group[]>(() => {
    const byRepository = new Map<string, Task[]>();
    for (const task of tasks) {
      for (const repository of task.repositories) {
        const bucket = byRepository.get(repository);
        if (bucket) bucket.push(task);
        else byRepository.set(repository, [task]);
      }
    }
    return [...byRepository.entries()]
      .map(([key, tasks]) => ({ key, label: key, tasks }))
      .sort((a, b) => openTopPriority(b.tasks, board.workflow) - openTopPriority(a.tasks, board.workflow) || b.tasks.length - a.tasks.length);
  }, [board.workflow, tasks]);

  const totals = useMemo(
    () => ({
      total: tasks.length,
      startable: tasks.filter((task) => task.readiness === "startable").length,
      waiting: tasks.filter((task) => task.readiness === "waiting").length,
      gateChecks: tasks.filter((task) => task.readiness === "needs-gate-check").length,
      openTopPriority: openTopPriority(tasks, board.workflow),
    }),
    [board.workflow, tasks],
  );

  /**
   * Work that claims to be moving and is not.
   *
   * This is the question the Markdown cannot answer at all: a status says what
   * a row *is*, never how long it has been that. It comes from git, so a row is
   * only stale once a commit has left it alone; the fact that nobody has
   * touched it is the finding.
   */
  const stale = useMemo(() => {
    if (Object.keys(lastChanged).length === 0) return [];
    return tasks
      .filter((task) => task.statusBase !== null && board.workflow.activeStatuses.includes(task.statusBase))
      .map((task) => ({ task, changed: lastChanged[task.id] }))
      .filter((entry) => entry.changed && daysSince(entry.changed.date) >= STALE_DAYS)
      .sort((a, b) => daysSince(b.changed!.date) - daysSince(a.changed!.date));
  }, [board.workflow.activeStatuses, tasks, lastChanged]);

  /** How much of the corpus carries a description at all. */
  const documented = useMemo(
    () => tasks.filter((task) => task.title !== null).length,
    [tasks],
  );

  const visibleIssues = useMemo(() => {
    if (tasks.length === board.tasks.length) return board.issues;
    const visibleIds = new Set(tasks.map((task) => task.id));
    return board.issues.filter((issue) => visibleIds.has(issue.taskId));
  }, [board.issues, board.tasks.length, tasks]);
  const visibleIssueGroups = useMemo(() => {
    const grouped = new Map<string, Array<(typeof visibleIssues)[number]>>();
    for (const issue of visibleIssues) {
      const bucket = grouped.get(issue.kind);
      if (bucket) bucket.push(issue);
      else grouped.set(issue.kind, [issue]);
    }
    return [...grouped.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [visibleIssues]);

  return (
    <div className="rollup space-y-6">
      <StatRow>
        <Stat label="Tasks tracked" value={totals.total} sub={`across ${epics.length} epics`} />
        <Stat
          label="Startable now"
          value={totals.startable}
          sub="every dependency satisfied"
          emphasis
          onClick={onOpenStartable}
        />
        <Stat label="Waiting" value={totals.waiting} sub="dependency is not satisfied" />
        <Stat label="Gate checks" value={totals.gateChecks} sub="blocked, gated, or ambiguous" />
        <Stat
          label="Top priority open"
          value={totals.openTopPriority}
          sub={`${board.workflow.priorityOrder[0] ?? "No priority"}, not closed`}
        />
      </StatRow>

      <div className="rollup-context">
        <p>
          {documented} of {tasks.length} rows carry a detail block with a title and scope
          {tasks.length === board.tasks.length && board.details.length > documented
            ? `; ${board.details.length - documented} more blocks belong to no row`
            : ""}
          .
        </p>
        <p>Click Startable now to turn this overview into a focused work queue.</p>
      </div>

      {stale.length > 0 ? (
        <section className="rollup-signal" aria-labelledby="stale-work-heading">
          <div className="rollup-section-heading">
            <div>
              <h2 id="stale-work-heading">Stale work</h2>
              <p>Active tasks whose latest Git change is at least {STALE_DAYS} days old.</p>
            </div>
            <span className="tabular">{stale.length}</span>
          </div>
          <ul className="stale-list">
            {stale.slice(0, 5).map((entry) => (
              <li key={entry.task.id}>
                <button
                  type="button"
                  className="stale-task-link focus-ring mono text-ui-accent hover:underline"
                  onClick={() => onSelectTask(entry.task.id)}
                >
                  {entry.task.id}
                </button>
                <StatusTag tone={statusTone(entry.task.statusBase, board.workflow)}>
                  {entry.task.statusBase}
                </StatusTag>
                <span className="tabular text-ui-text-subtle">{age(entry.changed!.date)}</span>
                <span className="stale-task">{entry.task.title ?? entry.task.outcome}</span>
              </li>
            ))}
          </ul>
          {stale.length > 5 ? (
            <details className="rollup-inline-disclosure">
              <summary>Show {stale.length - 5} more</summary>
              <ul className="stale-list mt-2">
                {stale.slice(5).map((entry) => (
                  <li key={entry.task.id}>
                    <button
                      type="button"
                      className="stale-task-link focus-ring mono text-ui-accent hover:underline"
                      onClick={() => onSelectTask(entry.task.id)}
                    >
                      {entry.task.id}
                    </button>
                    <StatusTag tone={statusTone(entry.task.statusBase, board.workflow)}>
                      {entry.task.statusBase}
                    </StatusTag>
                    <span className="tabular text-ui-text-subtle">{age(entry.changed!.date)}</span>
                    <span className="stale-task">{entry.task.title ?? entry.task.outcome}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}

      {visibleIssues.length > 0 ? (
        <details className="data-quality">
          <summary>
            <span>
              <span className="data-quality-mark" aria-hidden />
              {visibleIssues.length} data-quality signal{visibleIssues.length === 1 ? "" : "s"}
            </span>
            <span>Review</span>
          </summary>
          <ul className="space-y-3">
            {visibleIssueGroups.map(([kind, issues]) => (
              <li key={kind}>
                <p className="mb-1 font-medium">
                  {kind.replaceAll("-", " ")} <span className="tabular">{issues.length}</span>
                </p>
                <ul>
                  {issues.map((issue) => (
                    <li key={`${issue.taskId}-${issue.kind}-${issue.detail}`}>
                      <button
                        type="button"
                        className="focus-ring mono text-ui-accent hover:underline"
                        onClick={() => onSelectTask(issue.taskId)}
                      >
                        {issue.taskId}
                      </button>{" "}
                      - {issue.detail}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <section className="rollup-section">
        <div className="rollup-section-heading">
          <div>
            <h2>By project</h2>
            <p>
              Cross-project work remains visible under every project it touches, so totals can
              overlap.
            </p>
          </div>
          <span className="tabular">{projects.length}</span>
        </div>
        <div className="rollup-grid">
          {projects.map((group) => (
            <GroupCard key={group.key} group={group} workflow={board.workflow} onOpen={() => onOpenProject(group.key)} />
          ))}
        </div>
      </section>

      <details className="rollup-disclosure">
        <summary>
          <span>
            <span role="heading" aria-level={2} className="rollup-disclosure-title">
              By epic
            </span>
            <span>Open a ledger-level breakdown when you need it.</span>
          </span>
          <span className="tabular">{epics.length} ledgers</span>
        </summary>
        <div className="rollup-grid">
          {epics.map((group) => (
            <GroupCard key={group.key} group={group} workflow={board.workflow} onOpen={() => onOpenEpic(group.key)} />
          ))}
        </div>
      </details>

      <details className="rollup-disclosure">
        <summary>
          <span>
            <span role="heading" aria-level={2} className="rollup-disclosure-title">
              By repository
            </span>
            <span>See the engineering ownership view without crowding the overview.</span>
          </span>
          <span className="tabular">{repositories.length} repositories</span>
        </summary>
        <div className="rollup-grid">
          {repositories.map((group) => (
            <GroupCard key={group.key} group={group} workflow={board.workflow} onOpen={() => onOpenRepository(group.key)} />
          ))}
        </div>
      </details>
    </div>
  );
}
