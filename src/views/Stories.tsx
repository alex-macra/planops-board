import type { FormEvent, JSX, ReactNode } from "react";
import { useMemo, useRef, useState } from "react";

import type { AuthorOperation, Board, Task, TaskTable } from "../api.ts";
import { Pill } from "../components/Pill.tsx";
import { StoryProgress, STORY_STATE_TONE } from "../components/StoryProgress.tsx";
import { messageOf } from "../state.ts";
import { ConfirmDialog } from "../ui/index.tsx";
import {
  storyProgressLabel,
  storyStateLabel,
  storyViewsInScope,
  unassignedTasks,
  type StoryView,
} from "../stories.ts";

interface Props {
  readonly board: Board;
  readonly tasks: readonly Task[];
  readonly onSelectStory: (storyId: string) => void;
  readonly onOpenBacklog: () => void;
  readonly onSelectTask?: (taskId: string) => void;
  readonly editable?: boolean;
  readonly onAuthor?: (file: string, operation: AuthorOperation) => Promise<boolean>;
  readonly onRefresh?: () => Promise<boolean>;
  readonly onSetStatus?: (task: Task, status: string) => Promise<void>;
  readonly onMessage?: (message: string, kind: "success" | "error" | "info") => void;
}

const NEXT_LABEL = { start: "next", "blocked-by": "blocked by" } as const;

/** The short form, for a card. The drawer prints the whole sentence. */
export function storyLine(view: StoryView): JSX.Element {
  const { story } = view;
  if (story.kind === "enabler" || !story.role) {
    return <>{story.outcome}</>;
  }
  return (
    <>
      As a <span className="story-role">{story.role}</span>, {story.outcome}
    </>
  );
}

interface DisclosureProps {
  readonly label: string;
  readonly className: string;
  readonly summary: ReactNode;
  readonly children: ReactNode;
  readonly initiallyOpen?: boolean;
}

function Disclosure({ label, className, summary, children, initiallyOpen = false }: DisclosureProps): JSX.Element {
  const [open, setOpen] = useState(initiallyOpen);
  return <details className={`roadmap-disclosure ${className}`} aria-label={label} open={open}
    onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="focus-ring">{summary}</summary>
    <div className="roadmap-body">{children}</div>
  </details>;
}

type AuthorProps = Pick<Props, "editable" | "onAuthor" | "onRefresh" | "onMessage">;

function useComposer({ editable, onAuthor, onRefresh, onMessage }: AuthorProps, focusKey: string) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [committed, setCommitted] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);

  const close = (): void => {
    setOpen(false);
    setError("");
    setCommitted(false);
    window.requestAnimationFrame(() => {
      const fallback = [...document.querySelectorAll<HTMLButtonElement>("button[data-roadmap-author-trigger]")]
        .find((button) => button.dataset.roadmapAuthorTrigger === focusKey);
      const target = trigger.current?.isConnected ? trigger.current : fallback;
      const story = target?.closest("details.roadmap-outcome");
      if (story instanceof HTMLDetailsElement && !story.open) story.open = true;
      target?.focus();
    });
  };
  const submit = async (file: string, operation: AuthorOperation, success: string): Promise<void> => {
    if (!editable || !onAuthor || inFlight.current || committed) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const refreshed = await onAuthor(file, operation);
      if (refreshed) {
        onMessage?.(success, "success");
        close();
      } else {
        setCommitted(true);
        setError("The write succeeded, but the view could not refresh. Refresh to see the saved item.");
        onMessage?.("The write succeeded, but the view could not refresh.", "error");
      }
    } catch (cause) {
      const message = messageOf(cause);
      setError(message);
      onMessage?.(`Refused: ${message}`, "error");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const refresh = async (): Promise<void> => {
    if (!onRefresh || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      if (await onRefresh()) {
        setError("");
        if (committed) close();
      } else setError("The view could not refresh. Try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return { open, setOpen, busy, error, committed, trigger, close, submit, refresh };
}

function FormActions({ busy, committed, onCancel }: { busy: boolean; committed: boolean; onCancel: () => void }): JSX.Element {
  return <div className="roadmap-form-actions">
    <button type="submit" className="roadmap-primary focus-ring" disabled={busy || committed}>Save</button>
    <button type="button" className="focus-ring" onClick={onCancel} disabled={busy}>Cancel</button>
  </div>;
}

function FormFeedback({ error, onRefresh, busy }: { error: string; onRefresh: () => void; busy: boolean }): JSX.Element | null {
  if (!error) return null;
  return <div className="roadmap-form-feedback" role="alert">
    <span>{error}</span>
    <button type="button" className="focus-ring" onClick={onRefresh} disabled={busy}>Refresh and retry</button>
  </div>;
}

function StoryCreate({ file, ...actions }: { file: string } & AuthorProps): JSX.Element {
  const focusKey = `story:${file}`;
  const composer = useComposer(actions, focusKey);
  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"story" | "enabler">("story");
  const [role, setRole] = useState("");
  const [outcome, setOutcome] = useState("");
  const [soThat, setSoThat] = useState("");
  const [demo, setDemo] = useState("");
  const [attempted, setAttempted] = useState(false);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setAttempted(true);
    if (!id.trim() || !title.trim() || !outcome.trim() || !soThat.trim()) return;
    void composer.submit(file, {
      operation: "create.story", id: id.trim(), title: title.trim(), kind,
      outcome: outcome.trim(), soThat: soThat.trim(),
      ...(kind === "story" && role.trim() ? { role: role.trim() } : {}),
      ...(demo.trim() ? { demo: demo.trim() } : {}),
    }, `Created ${id.trim()} in ${file}`);
  };
  return <div className="roadmap-create">
    <button ref={composer.trigger} type="button" className="focus-ring roadmap-add" data-roadmap-author-trigger={focusKey} aria-expanded={composer.open}
      onClick={() => composer.setOpen(true)} disabled={!actions.editable || !actions.onAuthor}>Add story in {file}</button>
    {composer.open ? <form className="roadmap-form" onSubmit={submit} noValidate aria-label={`Create story in ${file}`}>
      <div className="roadmap-form-grid">
        <label>Story ID<input value={id} onChange={(event) => setId(event.target.value)} autoFocus aria-invalid={attempted && !id.trim()} /></label>
        <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} aria-invalid={attempted && !title.trim()} /></label>
        <label>Kind<select value={kind} onChange={(event) => setKind(event.target.value as "story" | "enabler")}><option value="story">Story</option><option value="enabler">Enabler</option></select></label>
        {kind === "story" ? <label>Role (optional)<input value={role} onChange={(event) => setRole(event.target.value)} /></label> : null}
      </div>
      <label>Outcome<textarea value={outcome} onChange={(event) => setOutcome(event.target.value)} aria-invalid={attempted && !outcome.trim()} /></label>
      {attempted && !outcome.trim() ? <p role="alert">Outcome is required.</p> : null}
      <label>So that<textarea value={soThat} onChange={(event) => setSoThat(event.target.value)} aria-invalid={attempted && !soThat.trim()} /></label>
      {attempted && !soThat.trim() ? <p role="alert">So that is required.</p> : null}
      <label>Demo (optional)<textarea value={demo} onChange={(event) => setDemo(event.target.value)} /></label>
      {attempted && (!id.trim() || !title.trim()) ? <p role="alert">Story ID and title are required.</p> : null}
      <FormFeedback error={composer.error} onRefresh={() => void composer.refresh()} busy={composer.busy} />
      <FormActions busy={composer.busy} committed={composer.committed} onCancel={composer.close} />
    </form> : null}
  </div>;
}

function TaskCreate({ board, file, storyId, ...actions }: { board: Board; file: string; storyId: string } & AuthorProps): JSX.Element {
  const focusKey = `task:${file}:${storyId}`;
  const composer = useComposer(actions, focusKey);
  const tables = board.taskTables.filter((table) => table.file === file);
  const [tableLine, setTableLine] = useState("");
  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const [cells, setCells] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const selected: TaskTable | undefined = tables.length === 1 ? tables[0] : tables.find((table) => String(table.headerLine) === tableLine);
  const status = selected?.headers.includes("Status") ? cells["Status"] ?? "" : "not-required";
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setAttempted(true);
    if (!selected || !id.trim() || !title.trim() || !status.trim()) return;
    const exactCells = Object.fromEntries(selected.headers.slice(1).map((header) => [header, cells[header] ?? ""]));
    void composer.submit(file, { operation: "create.task", id: id.trim(), storyId,
      title: title.trim(), tableHeaderLine: selected.headerLine, cells: exactCells }, `Created ${id.trim()} under ${storyId}`);
  };
  if (tables.length === 0) return <p className="roadmap-help">No supported task table in {file}. Add a valid task table to this file before creating a task.</p>;
  const vocabulary = board.documents.find((document) => document.path === file)?.vocabulary.bases ?? [];
  return <div className="roadmap-create">
    <button ref={composer.trigger} type="button" className="focus-ring roadmap-add" data-roadmap-author-trigger={focusKey} aria-expanded={composer.open}
      onClick={() => composer.setOpen(true)} disabled={!actions.editable || !actions.onAuthor}>Add task to {storyId}</button>
    {composer.open ? <form className="roadmap-form" onSubmit={submit} noValidate aria-label={`Create task for ${storyId}`}>
      {tables.length > 1 ? <label>Task table in {file} for {storyId}<select value={tableLine} onChange={(event) => { setTableLine(event.target.value); setCells({}); }} aria-invalid={attempted && !selected}>
        <option value="">Choose a table</option>
        {tables.map((table) => <option key={table.headerLine} value={String(table.headerLine)}>Line {table.headerLine}: {table.headers.join(" | ")}</option>)}
      </select></label> : <p className="roadmap-help">Table at line {selected?.headerLine} in {file}</p>}
      {attempted && !selected ? <p role="alert">Choose a task table.</p> : null}
      <div className="roadmap-form-grid">
        <label>Task ID<input value={id} onChange={(event) => setId(event.target.value)} aria-invalid={attempted && !id.trim()} /></label>
        <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} aria-invalid={attempted && !title.trim()} /></label>
      </div>
      {selected?.headers.slice(1).map((header) => <label key={header}>{header}
        {header === "Status" ? <select value={cells[header] ?? ""} onChange={(event) => setCells((current) => ({ ...current, [header]: event.target.value }))} aria-invalid={attempted && !status.trim()}>
          <option value="">Choose status</option>{vocabulary.map((value) => <option key={value} value={value}>{value}</option>)}
        </select> : ["Priority", "Severity", "Severity/risk"].includes(header) ? <select value={cells[header] ?? ""} onChange={(event) => setCells((current) => ({ ...current, [header]: event.target.value }))}>
          <option value="">No priority</option>{board.workflow.priorityOrder.map((value) => <option key={value} value={value}>{value}</option>)}
        </select> : <input value={cells[header] ?? ""} onChange={(event) => setCells((current) => ({ ...current, [header]: event.target.value }))} />}
      </label>)}
      {attempted && (!id.trim() || !title.trim() || !status.trim()) ? <p role="alert">Task ID, title, and status are required.</p> : null}
      <FormFeedback error={composer.error} onRefresh={() => void composer.refresh()} busy={composer.busy} />
      <FormActions busy={composer.busy} committed={composer.committed} onCancel={composer.close} />
    </form> : null}
  </div>;
}

function SubtaskCreate({ task, ...actions }: { task: Task } & AuthorProps): JSX.Element {
  const focusKey = `subtask:${task.file}:${task.id}`;
  const composer = useComposer(actions, focusKey);
  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const [owner, setOwner] = useState("");
  const [attempted, setAttempted] = useState(false);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setAttempted(true);
    if (!id.trim() || !title.trim()) return;
    void composer.submit(task.file, { operation: "create.subtask", taskId: task.id,
      id: id.trim(), title: title.trim(), ...(owner.trim() ? { owner: owner.trim() } : {}) }, `Created ${id.trim()} under ${task.id}`);
  };
  return <div className="roadmap-create">
    <button ref={composer.trigger} type="button" className="focus-ring roadmap-add" data-roadmap-author-trigger={focusKey} aria-expanded={composer.open}
      onClick={() => composer.setOpen(true)} disabled={!actions.editable || !actions.onAuthor}>Add subtask to {task.id}</button>
    {composer.open ? <form className="roadmap-form" onSubmit={submit} noValidate aria-label={`Create subtask for ${task.id}`}>
      <div className="roadmap-form-grid">
        <label>Subtask ID<input value={id} onChange={(event) => setId(event.target.value)} aria-invalid={attempted && !id.trim()} placeholder={`${task.id}.1`} /></label>
        <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} aria-invalid={attempted && !title.trim()} /></label>
        <label>Owner (optional)<input value={owner} onChange={(event) => setOwner(event.target.value)} /></label>
      </div>
      {attempted && (!id.trim() || !title.trim()) ? <p role="alert">Subtask ID and title are required.</p> : null}
      <FormFeedback error={composer.error} onRefresh={() => void composer.refresh()} busy={composer.busy} />
      <FormActions busy={composer.busy} committed={composer.committed} onCancel={composer.close} />
    </form> : null}
  </div>;
}

function DraftPanel({ id, context, onMessage }: { id: string; context: string; onMessage?: Props["onMessage"] }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState<string | null>(null);
  const [editContext, setEditContext] = useState(context);
  const [feedback, setFeedback] = useState("");
  const draft = intent ?? `Draft a plan for ${id}.\n\nContext:\n${context}\n\nReturn a proposed draft for human review.`;
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(draft);
      setFeedback("Intent copied. Submit it to an external agent manually.");
      onMessage?.(`Intent for ${id} copied for manual submission.`, "info");
    } catch {
      setFeedback("Could not copy intent. Select and copy the text manually.");
    }
  };
  return <div className="roadmap-draft">
    <button type="button" className="focus-ring roadmap-add" aria-expanded={open} onClick={() => setOpen((value) => !value)}>Draft with agent for {id}</button>
    {open ? <section className="roadmap-form" aria-label={`Agent draft intent for ${id}`}>
      <p className="roadmap-help">Edit this intent, then copy it. Submit it to an external agent manually. No agent runs from this Board.</p>
      {intent !== null && editContext !== context ? <p className="roadmap-help">Source context changed. Review your edited intent before copying.</p> : null}
      <label>Intent for {id}<textarea value={draft} onChange={(event) => { setIntent(event.target.value); setEditContext(context); }} rows={6} /></label>
      <button type="button" className="focus-ring roadmap-primary" onClick={() => void copy()}>Copy intent for {id}</button>
      <p role="status" aria-live="polite">{feedback}</p>
    </section> : null}
  </div>;
}

function SubtaskRow({ task, subtask, ...actions }: { task: Task; subtask: Task["subtasks"][number] } & AuthorProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [committed, setCommitted] = useState(false);
  const inFlight = useRef(false);
  const toggle = async (): Promise<void> => {
    if (!actions.editable || !actions.onAuthor || inFlight.current || committed) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const refreshed = await actions.onAuthor(task.file, { operation: "toggle.subtask", taskId: task.id, id: subtask.id });
      if (refreshed) actions.onMessage?.(`Toggled ${subtask.id}`, "success");
      else {
        setCommitted(true);
        setError("The toggle succeeded, but the view could not refresh.");
      }
    } catch (cause) {
      setError(messageOf(cause));
      actions.onMessage?.(`Refused: ${messageOf(cause)}`, "error");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const refresh = async (): Promise<void> => {
    if (inFlight.current || !actions.onRefresh) return;
    if (await actions.onRefresh()) { setError(""); setCommitted(false); }
  };
  return <li className="roadmap-subtask">
    <label><input type="checkbox" checked={subtask.done} disabled={!actions.editable || !task.writable || busy || committed}
      onChange={() => void toggle()} /> <span>{subtask.id} {subtask.title}{subtask.owner ? ` - ${subtask.owner}` : ""}</span></label>
    <DraftPanel id={subtask.id} context={`Subtask: ${subtask.title}\nParent task: ${task.id} ${task.title ?? task.outcome}`} onMessage={actions.onMessage} />
    {error ? <p role="alert">{error} <button type="button" className="focus-ring" onClick={() => void refresh()}>Refresh</button></p> : null}
  </li>;
}

function TaskRow({ task, board, onSelectTask, onSetStatus, ...actions }: {
  task: Task; board: Board; onSelectTask?: Props["onSelectTask"]; onSetStatus?: Props["onSetStatus"];
} & AuthorProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [committed, setCommitted] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);
  const inFlight = useRef(false);
  const vocabulary = board.documents.find((document) => document.path === task.file)?.vocabulary.bases ?? [];
  const requestStatus = (status: string): void => {
    if (status === task.statusBase) return;
    if (task.statusQualifier) setPendingStatus(status);
    else void changeStatus(status);
  };
  const changeStatus = async (status: string): Promise<void> => {
    if (!actions.editable || !onSetStatus || inFlight.current || committed) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await onSetStatus(task, status);
      if (await actions.onRefresh?.() === false) {
        setCommitted(true);
        setError("The status changed, but the view could not refresh.");
      } else actions.onMessage?.(`${task.id} moved to ${status}`, "success");
    } catch (cause) {
      setError(messageOf(cause));
      actions.onMessage?.(`Refused: ${messageOf(cause)}`, "error");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return <li className="roadmap-task">
    <div className="roadmap-task-head">
      <span className="mono">{task.id}</span><span>{task.title ?? task.outcome}</span>
      {onSelectTask ? <button type="button" className="focus-ring roadmap-add" onClick={() => onSelectTask(task.id)}>Open task {task.id}</button> : null}
      {actions.editable && task.writable && task.statusCell && onSetStatus ? <label>Status for {task.id}
        <select value={task.statusBase ?? ""} disabled={busy || committed} onChange={(event) => requestStatus(event.target.value)}>
          {task.statusBase === null ? <option value="">Unknown status</option> : null}
          {vocabulary.map((status) => <option key={status} value={status}>{status}</option>)}
        </select>
      </label> : <span className="roadmap-help">{task.status}</span>}
    </div>
    {error ? <p role="alert">{error} <button type="button" className="focus-ring" onClick={() => void actions.onRefresh?.().then((ok) => { if (ok) { setError(""); setCommitted(false); } })}>Refresh</button></p> : null}
    <DraftPanel id={task.id} context={`Task: ${task.title ?? task.outcome}\nOutcome: ${task.outcome}\nStatus: ${task.status}`} onMessage={actions.onMessage} />
    {task.subtasks.length ? <ul className="roadmap-subtasks">{task.subtasks.map((subtask) => <SubtaskRow key={subtask.id} task={task} subtask={subtask} {...actions} />)}</ul>
      : <p className="roadmap-help">No subtasks yet.</p>}
    {actions.editable && task.writable ? <SubtaskCreate task={task} {...actions} /> : null}
    <ConfirmDialog open={pendingStatus !== null} title={`Move ${task.id} to ${pendingStatus ?? ""}?`}
      description={<>This drops the qualifier <span className="mono">“{task.statusQualifier}”</span>. Use the task detail instead if you want to keep it.</>}
      confirmLabel="Move and drop qualifier" onCancel={() => setPendingStatus(null)} onConfirm={() => {
        const status = pendingStatus;
        setPendingStatus(null);
        if (status) void changeStatus(status);
      }} />
  </li>;
}

function Card({ view, onOpen, board, onSelectTask, onSetStatus, ...actions }: {
  view: StoryView; onOpen: () => void; board: Board; onSelectTask?: Props["onSelectTask"]; onSetStatus?: Props["onSetStatus"];
} & AuthorProps): JSX.Element {
  const edge = view.state === "blocked" ? "story-card-blocked" : "";
  const source = `${view.story.file} line ${view.story.headingLine}`;
  const kind = view.story.kind === "enabler" ? "Enabler" : "Story";
  return (
    <Disclosure className={`roadmap-outcome ${edge}`} label={`${kind} ${view.story.id} from ${source}`} summary={<>
      <span className="story-card-top">
        <span className="story-card-id">{view.story.id}</span>
        <span className="story-kind">{view.story.kind}</span>
        <span className="ml-auto">
          <Pill tone={STORY_STATE_TONE[view.state]}>{storyStateLabel(view.state)}</Pill>
        </span>
      </span>

      <span className="story-line">{storyLine(view)}</span>

      <StoryProgress view={view} />

      <span className="story-foot">
        <span>
          Full group: {storyProgressLabel(view)}
          {view.missing.length > 0 ? ` · ${view.missing.length} unknown` : ""}
        </span>
        {view.next ? (
          <span>
            {NEXT_LABEL[view.next.kind]} <b>{view.next.taskId}</b>
          </span>
        ) : null}
      </span>
      <span className="roadmap-source">{source}</span>
    </>}>
      <button type="button" className="focus-ring text-sm text-ui-accent hover:underline"
        aria-label={`Open story ${view.story.id} from ${source}`} onClick={onOpen}>Open story</button>
      <DraftPanel id={view.story.id} context={`Story: ${view.story.title}\nOutcome: ${view.story.outcome}\nSo that: ${view.story.soThat}`} onMessage={actions.onMessage} />
      {view.members.length ? <ul className="roadmap-tasks">{view.members.map((task) => <TaskRow key={`${task.file}:${task.id}:${task.line}`}
        task={task} board={board} onSelectTask={onSelectTask} onSetStatus={onSetStatus} {...actions} />)}</ul>
        : <p className="roadmap-help">No tasks yet.</p>}
      {actions.editable && board.documents.some((document) => document.path === view.story.file && document.writable)
        ? <TaskCreate board={board} file={view.story.file} storyId={view.story.id} {...actions} /> : null}
    </Disclosure>
  );
}

export function Stories({ board, tasks, onSelectStory, onOpenBacklog, onSelectTask, onSetStatus,
  editable = false, onAuthor, onRefresh, onMessage }: Props): JSX.Element {
  const views = useMemo(() => storyViewsInScope(board, tasks), [board, tasks]);
  const authorActions = { editable, onAuthor, onRefresh, onMessage };
  const emptyFiles = board.documents.filter((document) => document.writable &&
    !board.stories.some((story) => story.file === document.path));
  const [emptyFile, setEmptyFile] = useState("");
  const selectedEmptyFile = emptyFile;

  /**
   * Laned by the products the member rows actually touch, not by the epic file:
   * a story is an outcome, and an outcome belongs to whoever would notice it.
   */
  const lanes = useMemo(() => {
    const projects = new Map(board.projects.map((project) => [project.id, project]));
    const byProject = new Map<string, StoryView[]>();
    for (const view of views) {
      const key = view.projects[0] ?? "unassigned";
      const bucket = byProject.get(key);
      if (bucket) bucket.push(view);
      else byProject.set(key, [view]);
    }
    const documents = new Map(board.documents.map((document) => [document.path, document]));
    return (
      [...byProject.entries()]
        .map(([id, stories]) => {
          const project = projects.get(id);
          const byFile = new Map<string, StoryView[]>();
          for (const view of stories) {
            const bucket = byFile.get(view.story.file);
            if (bucket) bucket.push(view);
            else byFile.set(view.story.file, [view]);
          }
          return {
            id,
            label: project?.label.trim() ? project.label : id,
            parked: project?.parked ?? null,
            stories,
            epics: [...byFile].map(([file, members]) => {
              const document = documents.get(file);
              return { file, stories: members, label: document?.title.trim() ? document.title : file };
            }),
          };
        })
        .sort(
          (a, b) =>
            Number(a.parked !== null) - Number(b.parked !== null) ||
            b.stories.length - a.stories.length ||
            a.label.localeCompare(b.label),
        )
    );
  }, [board.projects, board.documents, views]);

  const uncovered = useMemo(() => unassignedTasks(board, tasks), [board, tasks]);

  return (
    <div className="roadmap-hierarchy space-y-6">
      <div className="rollup-context">
        <p>
          {views.length} {views.length === 1 ? "story" : "stories"} over{" "}
          {tasks.length - uncovered.length} of {tasks.length} rows. Story state and progress are
          derived from the tasks assigned to it.
        </p>
        <p>
          A <b>story</b> names a role. An <b>enabler</b> names the capability instead, for the
          platform work that has no end user.
        </p>
      </div>

      {lanes.map((lane) => (
        <Disclosure className="roadmap-project" key={lane.id} label={`Project ${lane.label}`} initiallyOpen summary={<>
          <span className="roadmap-heading"><span className="view-eyebrow">Project</span><strong>{lane.label}</strong></span>
          <span className="roadmap-count">{lane.epics.length} {lane.epics.length === 1 ? "epic" : "epics"} ·{" "}
            {lane.stories.length} {lane.stories.length === 1 ? "outcome" : "outcomes"}</span>
            {lane.parked ? (
              <span className="pill pill-deferred">parked {lane.parked.since}</span>
            ) : null}
        </>}>
          {lane.epics.map((epic) => <Disclosure className="roadmap-epic" key={JSON.stringify([lane.id, epic.file])}
            label={`Epic ${epic.file} in ${lane.id}`} initiallyOpen summary={<>
              <span className="roadmap-heading"><span className="view-eyebrow">Epic</span><strong>{epic.label}</strong>
                <span className="roadmap-source">{epic.file}</span></span>
              <span className="roadmap-count">{epic.stories.length} {epic.stories.length === 1 ? "outcome" : "outcomes"}</span>
            </>}>
            {epic.stories.map((view) => <Card key={JSON.stringify([view.story.file, view.story.id, view.story.headingLine])}
              view={view} board={board} onSelectTask={onSelectTask} onSetStatus={onSetStatus} {...authorActions}
              onOpen={() => onSelectStory(view.story.id)} />)}
            {editable && board.documents.some((document) => document.path === epic.file && document.writable)
              ? <StoryCreate file={epic.file} {...authorActions} /> : null}
          </Disclosure>)}
        </Disclosure>
      ))}

      {uncovered.length > 0 ? (
        <div className="now-folded">
          <b>Not in a story yet:</b>
          <span className="tabular">{uncovered.length} rows</span>
          <span>Your current project scope and row filters remain in effect when opening the backlog.</span>
          <button
            type="button"
            className="focus-ring ml-auto text-ui-accent hover:underline"
            onClick={onOpenBacklog}
          >
            Open backlog
          </button>
        </div>
      ) : null}

      {views.length === 0 ? (
        <p className="text-sm text-ui-text-muted">
          No story blocks in this scope yet. A story is a{" "}
          <code className="mono text-xs">### PREFIX-S01</code> block in an epic file; see
          the README for the supported fields.
        </p>
      ) : null}
      {editable && emptyFiles.length > 0 ? <section className="roadmap-empty-create" aria-label="Create story in an empty file">
        <h2>Start a story in a writable file</h2>
        <label>Story file<select value={emptyFile} onChange={(event) => setEmptyFile(event.target.value)}>
          <option value="">Choose a file</option>{emptyFiles.map((document) => <option key={document.path} value={document.path}>{document.title} - {document.path}</option>)}
        </select></label>
        {selectedEmptyFile && emptyFiles.some((document) => document.path === selectedEmptyFile)
          ? <StoryCreate key={selectedEmptyFile} file={selectedEmptyFile} {...authorActions} /> : null}
      </section> : null}
    </div>
  );
}
