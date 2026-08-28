import { Button, Drawer, Input, KV, Label, Select } from "../ui/index.tsx";
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";

import type { Board, DetailField, Task } from "../api.ts";
import { detailOf, vocabularyOf } from "../api.ts";
import { buildDependencyGraph, type DependencyDisplayEdge } from "../dependency-graph.ts";
import { readinessReasons } from "../readiness.ts";
import { stampDateOf, withoutStamp } from "../../shared/stamp.ts";
import { canonicalTaskUrl, taskSummary } from "../task-navigation.ts";
import { parseStatusValue } from "../../shared/status.ts";
import { Notice } from "./Notice.tsx";
import { StatusTag, Tag } from "./Tag.tsx";
import { TaskActivity } from "./TaskActivity.tsx";
import { priorityTone, statusTone } from "./tone.ts";

export type TaskDrawerMode =
  | { readonly kind: "viewer" }
  | {
      readonly kind: "local";
      readonly onSaveStatus: (task: Task, status: string) => Promise<void>;
      readonly onSavePriority: (task: Task, priority: string) => Promise<void>;
      readonly onAddNote: (task: Task, text: string, title?: string) => Promise<void>;
    };

interface Props {
  readonly task: Task | null;
  readonly board: Board;
  readonly onClose: () => void;
  readonly mode: TaskDrawerMode;
  readonly onSelectTask: (taskId: string) => void;
  readonly onOpenGraph: (taskId: string) => void;
  readonly sourceRef: string;
  readonly sourceSha: string;
}

/** Columns already shown as first-class fields; the rest go in "Other columns". */
const MODELLED_HEADERS = new Set([
  "ID",
  "Remediation ID",
  "Status",
  "Priority",
  "Dependencies",
]);

/** Rendered above the fold as the description; the rest keep their own labels. */
const LEAD_FIELD = "Scope";

function uncertaintyLabels(edge: DependencyDisplayEdge): readonly string[] {
  return edge.uncertainty.flatMap((kind) => {
    switch (kind) {
      case "ambiguous": return ["defined more than once"];
      case "cycle": return ["participates in a dependency cycle"];
      case "closed": return ["has a closed prerequisite that does not satisfy dependencies"];
      case "duplicate": return ["listed more than once"];
      case "gate": return [`requires @${edge.gate ?? "a gate"}`];
      case "residue": return ["has unparsed dependency text"];
      case "self": return ["lists this task itself as a prerequisite"];
      case "unresolved": return ["is not defined in a unique ledger row"];
    }
  });
}

function rawDependencyLabels(task: Task, dependency: Task["dependencies"][number]): readonly string[] {
  const labels: string[] = [];
  if (!dependency.resolved && !dependency.ambiguous) labels.push("not defined in any ledger");
  if (dependency.ambiguous) labels.push("defined more than once");
  if (dependency.duplicate) labels.push("listed more than once");
  if (dependency.gate) labels.push(`requires @${dependency.gate}`);
  if (dependency.id === task.id) labels.push("lists this task itself");
  return labels;
}

/**
 * Task IDs in prose are clickable, just like IDs in the dependency column.
 * Task IDs in detail prose can name work that no table column carries.
 */
function Prose({
  text,
  onSelectTask,
}: {
  readonly text: string;
  readonly onSelectTask: (taskId: string) => void;
}): JSX.Element {
  const parts = text.split(/`([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)`/g);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <button
            key={index}
            type="button"
            className="mono text-ui-accent hover:underline"
            onClick={() => onSelectTask(part)}
          >
            {part}
          </button>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

function Field({
  field,
  onSelectTask,
}: {
  readonly field: DetailField;
  readonly onSelectTask: (taskId: string) => void;
}): JSX.Element {
  return (
    <section>
      <h3 className="mb-1.5 text-xs font-medium text-ui-text-muted">
        {field.label}
        {field.date ? <span className="ml-1.5 tabular font-normal">{field.date}</span> : null}
        {field.label === "Acceptance criteria" && field.items.length > 1 ? (
          <span className="ml-1.5 tabular font-normal">{field.items.length}</span>
        ) : null}
      </h3>
      {field.items.length === 1 ? (
        <p className="text-sm leading-relaxed text-ui-text">
          <Prose text={field.items[0]!} onSelectTask={onSelectTask} />
        </p>
      ) : (
        <ul className="ml-4 list-disc space-y-1 text-sm leading-relaxed text-ui-text marker:text-ui-text-subtle">
          {field.items.map((item, index) => (
            <li key={index}>
              <Prose text={item} onSelectTask={onSelectTask} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function TaskDrawer({
  task,
  board,
  onClose,
  mode,
  onSelectTask,
  onOpenGraph,
  sourceRef,
  sourceSha,
}: Props): JSX.Element | null {
  const [base, setBase] = useState("");
  const [qualifier, setQualifier] = useState("");
  const [priority, setPriority] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; details?: string } | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [copyFallback, setCopyFallback] = useState<{ readonly label: string; readonly value: string } | null>(null);
  const drawerFocusTarget = useRef<HTMLDivElement>(null);
  const activeTaskId = useRef<string | null>(task?.id ?? null);
  const copyRequest = useRef(0);
  activeTaskId.current = task?.id ?? null;

  useEffect(() => {
    setBase(task?.statusBase ?? "");
    setQualifier(task?.statusQualifier ?? "");
    setPriority(task?.priority ?? "");
    setFailure(null);
    setCopyMessage(null);
    setCopyFallback(null);
  }, [task?.id]);

  useEffect(() => {
    setBase(task?.statusBase ?? "");
    setQualifier(task?.statusQualifier ?? "");
  }, [task?.id, task?.status]);

  useEffect(() => {
    setPriority(task?.priority ?? "");
  }, [task?.id, task?.priority]);

  useEffect(() => {
    if (!task) return;
    const frame = window.requestAnimationFrame(() => drawerFocusTarget.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [task?.id]);

  if (!task) return null;

  const detail = detailOf(board, task.id);
  const lead = detail?.fields.find((field) => field.label === LEAD_FIELD) ?? null;
  // Notes have their own place in the activity section, below.
  const otherFields =
    detail?.fields.filter((field) => field !== lead && field.label !== "Note") ?? [];
  // Only http links: a relative one points into the repository, where a browser
  // tab cannot follow it anyway.
  const links = (detail?.links ?? []).filter((link) => /^https?:/.test(link.href));
  const stampDate = stampDateOf(task.outcome);
  const outcome = withoutStamp(task.outcome);

  const bases = vocabularyOf(board, task);
  const separator = parseStatusValue(task.status, bases).separator || " - ";
  const nextStatus = qualifier ? `${base}${separator}${qualifier}` : base;
  const statusChanged = nextStatus !== task.status;
  const priorityChanged = priority !== (task.priority ?? "");
  const readinessDetail = readinessReasons(board, task);
  const graph = buildDependencyGraph(board.tasks, board.workflow);
  const directPrerequisites = graph.directPrerequisites(task.id);
  const prerequisiteEntries = graph.directPrerequisiteEntries(task.id);
  const upstreamCount = graph.upstreamOf(task.id).size;
  const dependantEntries = graph.directDependantEntries(task.id);
  const uncertainDependants = graph.directUncertainDependants(task.id);
  const impact = graph.actionableFanOut(task.id);
  const visiblePrerequisites = prerequisiteEntries.slice(0, 8);
  const visibleDependants = dependantEntries.slice(0, 8);
  const unlinkedPrerequisites = task.dependencies.filter((dependency) =>
    dependency.id === task.id || !graph.tasksById.has(dependency.id),
  );
  const dependencyUncertainty =
    graph.cycleIds.has(task.id) ||
    uncertainDependants.length > 0 ||
    task.dependencyResidue.length > 0 ||
    prerequisiteEntries.some((entry) => entry.uncertainty.length > 0) ||
    unlinkedPrerequisites.length > 0;
  const canonicalUrl = typeof window === "undefined"
    ? `#task=${encodeURIComponent(task.id)}`
    : canonicalTaskUrl(window.location.origin, window.location.pathname, task.id);
  const summary = taskSummary(task, { sourceRef, sourceSha, canonicalUrl });

  async function save(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setFailure(null);
    try {
      await action();
    } catch (error) {
      const failureBody = (error as { failure?: { error: string; details?: string } }).failure;
      setFailure({
        message: failureBody?.error ?? String(error),
        ...(failureBody?.details ? { details: failureBody.details } : {}),
      });
    } finally {
      setBusy(false);
    }
  }

  async function copy(label: string, value: string): Promise<void> {
    const requestedFor = task?.id;
    if (!requestedFor) return;
    const request = ++copyRequest.current;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(value);
      if (copyRequest.current !== request || activeTaskId.current !== requestedFor) return;
      setCopyFallback(null);
      setCopyMessage(`${label} copied.`);
    } catch {
      if (copyRequest.current !== request || activeTaskId.current !== requestedFor) return;
      setCopyFallback({ label, value });
      setCopyMessage(`${label} could not be copied automatically. Select the text below instead.`);
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      side="right"
      size="lg"
      title={detail?.title ? `${task.id} - ${detail.title}` : task.id}
    >
      <div className="space-y-5">
        <div ref={drawerFocusTarget} tabIndex={-1} data-testid="task-drawer-focus" className="focus-ring rounded-lg">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <StatusTag tone={statusTone(task.statusBase, board.workflow)}>
              {task.statusBase ?? "no status"}
            </StatusTag>
            {task.priority ? <Tag tone={priorityTone(task.priority, board.workflow.priorityOrder)}>{task.priority}</Tag> : null}
            {task.readiness === "startable" ? (
              <StatusTag tone="progress">startable now</StatusTag>
            ) : null}
            {task.readiness === "waiting" ? <StatusTag tone="deferred">waiting</StatusTag> : null}
            {task.readiness === "needs-gate-check" ? (
              <StatusTag tone="blocked">needs gate check</StatusTag>
            ) : null}
            {stampDate ? (
              <span className="tabular text-xs text-ui-text-subtle">set {stampDate}</span>
            ) : null}
          </div>
        </div>

        {readinessDetail.length > 0 ? (
          <section className="rounded-xl border border-ui-border bg-ui-bg-muted p-3">
            <h3 className="text-xs font-medium text-ui-text">
              {task.readiness === "startable" ? "Why it is ready" : "Why it is not ready"}
            </h3>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-xs leading-relaxed text-ui-text-muted">
              {readinessDetail.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          </section>
        ) : null}

        {/* The scope, when the block has one, is the description the outcome
         * column was never long enough to be. */}
        {lead ? (
          <p className="text-sm leading-relaxed text-ui-text">
            <Prose text={lead.items.join(" ")} onSelectTask={onSelectTask} />
          </p>
        ) : null}

        <p className={lead ? "text-xs text-ui-text-muted" : "text-sm text-ui-text"}>
          {outcome || "No outcome recorded."}
        </p>

        <section className="space-y-2 rounded-xl border border-ui-border bg-ui-bg-muted p-3">
          <h3 className="text-xs font-medium text-ui-text">Share this task</h3>
          <p className="text-xs text-ui-text-muted">
            Copy a task link or a concise Markdown summary. Copying does not edit the repository.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" className="min-h-11" onClick={() => void copy("Task link", canonicalUrl)}>
              Copy task link
            </Button>
            <Button size="sm" variant="ghost" className="min-h-11" onClick={() => void copy("Task summary", summary)}>
              Copy task summary
            </Button>
          </div>
          {copyMessage ? <p role="status" className="text-xs text-ui-text-muted">{copyMessage}</p> : null}
          {copyFallback ? (
            <label className="block space-y-1.5" htmlFor="task-copy-fallback">
              <span className="text-xs font-medium text-ui-text-muted">{copyFallback.label} fallback</span>
              <textarea
                id="task-copy-fallback"
                readOnly
                value={copyFallback.value}
                className="focus-ring min-h-28 w-full rounded-lg border border-ui-border bg-ui-bg px-3 py-2 font-mono text-xs text-ui-text"
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
          ) : null}
        </section>

        {otherFields.map((field) => (
          <Field key={field.label} field={field} onSelectTask={onSelectTask} />
        ))}

        {detail?.prose.length ? (
          <section className="space-y-2 text-sm leading-relaxed text-ui-text">
            {detail.prose.map((paragraph, index) =>
              paragraph.startsWith("```") ? (
                <pre key={index} className="mono overflow-x-auto rounded-lg bg-ui-bg-muted p-2 text-xs">
                  {paragraph.replace(/^```.*\n?|\n?```$/g, "")}
                </pre>
              ) : (
                <p key={index}>
                  <Prose text={paragraph} onSelectTask={onSelectTask} />
                </p>
              ),
            )}
          </section>
        ) : null}

        {detail === null ? (
          <p className="text-xs text-ui-text-subtle">
            No detail block in the ledger. Adding a note creates one.
          </p>
        ) : null}

        <div className="kv-quiet text-sm">
          <KV k="Epic" v={task.epic} />
          {task.section ? <KV k="Section" v={task.section} /> : null}
          <KV k="Owners" v={task.owners.length ? task.owners.join(", ") : "-"} />
          <KV
            k="Source"
            v={
              <span className="mono text-xs">
                {task.file}:{task.line}
              </span>
            }
          />
          {detail ? (
            <KV
              k="Detail"
              v={
                <span className="mono text-xs">
                  {detail.file}:{detail.headingLine}
                </span>
              }
            />
          ) : null}
        </div>

        {links.length > 0 ? (
          <section>
            <h3 className="mb-1.5 text-xs font-medium text-ui-text-muted">Evidence</h3>
            <ul className="flex flex-wrap gap-1.5">
              {links.map((link, index) => (
                <li key={index}>
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noreferrer"
                    className="touch-link inline-flex rounded bg-ui-bg-muted px-1.5 py-0.5 text-[11px] text-ui-accent hover:underline"
                  >
                    {link.label || link.href}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {task.dependencies.length > 0 || task.dependencyResidue.length > 0 ? (
          <section className="space-y-2">
            <h3 className="mb-1.5 text-xs font-medium text-ui-text-muted">
              Needs before this
            </h3>
            <ul className="space-y-1">
              {visiblePrerequisites.map((edge) => {
                const prerequisite = edge.prerequisite;
                const state = prerequisite.status || "not defined";
                const stateLabel = prerequisite.statusBase !== null && board.workflow.dependencySatisfiedStatuses.includes(prerequisite.statusBase)
                  ? "satisfied"
                  : prerequisite.statusBase !== null && board.workflow.closedStatuses.includes(prerequisite.statusBase)
                    ? "closed conflict"
                    : state;
                const checks = uncertaintyLabels(edge);
                return (
                  <li key={prerequisite.id}>
                    <button
                      type="button"
                      className="focus-ring min-h-11 rounded-lg px-2 text-left font-mono text-xs text-ui-accent hover:bg-ui-bg-muted hover:underline"
                      onClick={() => onSelectTask(prerequisite.id)}
                    >
                      {prerequisite.id}
                    </button>
                    <span className="ml-2 text-xs text-ui-text-subtle">
                      {stateLabel}
                      {prerequisite.priority ? ` · ${prerequisite.priority}` : ""}
                      {prerequisite.readiness ? ` · ${prerequisite.readiness}` : ""}
                    </span>
                    {checks.length > 0 ? (
                      <span className="ml-2 text-xs text-ui-danger">{checks.join("; ")}</span>
                    ) : null}
                  </li>
                );
              })}
              {prerequisiteEntries.length > visiblePrerequisites.length ? (
                <li className="text-xs text-ui-text-subtle">
                  {prerequisiteEntries.length - visiblePrerequisites.length} more direct prerequisites in the full graph.
                </li>
              ) : null}
              {upstreamCount > directPrerequisites.length ? (
                <li className="text-xs text-ui-text-subtle">
                  {upstreamCount - directPrerequisites.length} additional resolved upstream prerequisites in the full graph.
                </li>
              ) : null}
              {unlinkedPrerequisites.slice(0, 8).map((dependency, index) => (
                <li key={`${dependency.raw}-${index}`} className="text-xs text-ui-danger">
                  <span className="mono">{dependency.id}</span>
                  <span className="ml-2">{rawDependencyLabels(task, dependency).join("; ")}</span>
                </li>
              ))}
              {unlinkedPrerequisites.length > 8 ? (
                <li className="text-xs text-ui-danger">
                  {unlinkedPrerequisites.length - 8} more unresolved or self-referencing prerequisites.
                </li>
              ) : null}
              {task.dependencyResidue.slice(0, 8).map((residue, index) => (
                <li key={`${residue}-${index}`} className="text-xs text-ui-danger">
                  Unparsed dependency text: {residue}
                </li>
              ))}
              {task.dependencyResidue.length > 8 ? (
                <li className="text-xs text-ui-danger">
                  {task.dependencyResidue.length - 8} more unparsed dependency entries.
                </li>
              ) : null}
            </ul>
          </section>
        ) : null}

        <section className="space-y-2 rounded-xl border border-ui-border bg-ui-bg-muted p-3">
          <div>
            <h3 className="text-xs font-medium text-ui-text">Unblocks next</h3>
            <p className="mt-1 text-xs text-ui-text-muted">
              {impact === 0
                ? "No confident open dependants are currently counted."
                : `Confidently unblocks ${impact} open ${impact === 1 ? "task" : "tasks"} through the dependency graph.`}
            </p>
          </div>
          {dependencyUncertainty ? (
            <p className="text-xs text-ui-danger">
              Gated, malformed, ambiguous, duplicate, or cyclic dependencies are excluded from this count.
            </p>
          ) : null}
          {visibleDependants.length > 0 ? (
            <ul className="space-y-1">
              {visibleDependants.map((edge) => {
                const dependant = edge.dependant;
                const checks = uncertaintyLabels(edge);
                return (
                <li key={dependant.id}>
                  <button
                    type="button"
                    className="focus-ring min-h-11 w-full rounded-lg px-2 py-1 text-left text-xs text-ui-accent hover:bg-ui-bg hover:underline"
                    onClick={() => onSelectTask(dependant.id)}
                  >
                    <span className="mono">{dependant.id}</span>
                    <span className="ml-2 text-ui-text-subtle">
                      {dependant.status || "no status"}
                      {dependant.priority ? ` · ${dependant.priority}` : ""}
                      {dependant.readiness ? ` · ${dependant.readiness}` : ""}
                    </span>
                  </button>
                  {checks.length > 0 ? (
                    <span className="ml-2 text-xs text-ui-danger">{checks.join("; ")}</span>
                  ) : null}
                </li>
              );
              })}
              {dependantEntries.length > visibleDependants.length ? (
                <li className="text-xs text-ui-text-subtle">
                  {dependantEntries.length - visibleDependants.length} more direct open dependants in the full graph.
                </li>
              ) : null}
            </ul>
          ) : null}
          <Button size="sm" variant="ghost" className="min-h-11" onClick={() => onOpenGraph(task.id)}>
            Open full dependency graph
          </Button>
        </section>

        {failure ? (
          <Notice tone="blocked" title={failure.message} onDismiss={() => setFailure(null)}>
            {failure.details ? (
              <pre className="mono max-h-40 overflow-auto whitespace-pre-wrap text-xs">
                {failure.details}
              </pre>
            ) : (
              "Nothing was written; the document is unchanged."
            )}
          </Notice>
        ) : null}

        {mode.kind !== "viewer" && task.statusCell ? (
          <section className="space-y-2 rounded-xl border border-ui-border p-3">
            <h3 className="text-xs font-medium text-ui-text-muted">
              Status
            </h3>
            <div>
              <Label htmlFor="status-base">Base state</Label>
              <Select
                id="status-base"
                value={base}
                onChange={(event) => setBase(event.target.value)}
                disabled={busy}
              >
                {bases.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="status-qualifier">Qualifier (optional)</Label>
              <Input
                id="status-qualifier"
                value={qualifier}
                placeholder="Add supporting context"
                onChange={(event) => setQualifier(event.target.value)}
                disabled={busy}
              />
            </div>
            <p className="mono text-xs text-ui-text-subtle">
              {nextStatus || "(empty)"}
            </p>
            <Button
              size="sm"
              disabled={!statusChanged || !base}
              loading={busy}
              onClick={() => void save(() => mode.onSaveStatus(task, nextStatus))}
            >
              Save status
            </Button>
          </section>
        ) : null}

        {mode.kind !== "viewer" && task.priorityCell ? (
          <section className="space-y-2 rounded-xl border border-ui-border p-3">
            <h3 className="text-xs font-medium text-ui-text-muted">
              Priority
            </h3>
            <Select
              aria-label="Priority"
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
              disabled={busy}
            >
              <option value="">Unset</option>
              {priority && !board.workflow.priorityOrder.includes(priority) ? (
                <option value={priority}>{priority} (document value)</option>
              ) : null}
              {board.workflow.priorityOrder.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </Select>
            <Button
              size="sm"
              variant="secondary"
              disabled={!priorityChanged}
              loading={busy}
              onClick={() => void save(() => mode.onSavePriority(task, priority))}
            >
              Save priority
            </Button>
          </section>
        ) : null}

        <TaskActivity
          task={task}
          detail={detail}
          workflow={board.workflow}
          onAddNote={
            mode.kind === "local"
              ? (text, title) => mode.onAddNote(task, text, title)
              : undefined
          }
        />

        <details>
          <summary className="cursor-pointer text-xs font-medium text-ui-text-muted">
            Other columns
          </summary>
          <div className="kv-quiet mt-2 text-sm">
            {Object.entries(task.raw)
              .filter(([header]) => !MODELLED_HEADERS.has(header))
              .map(([header, value]) => (
                <KV key={header} k={header} v={value || "-"} />
              ))}
          </div>
        </details>
      </div>
    </Drawer>
  );
}
