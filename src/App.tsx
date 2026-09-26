import {
  Button,
  DarkModeToggle,
  DropdownMenu,
  FilterBar,
  SegmentedControl,
  Select,
  Skeleton,
  ToastProvider,
  useDarkMode,
  useToast,
} from "./ui/index.tsx";
import { Check, MoreHorizontal, RefreshCw, Search, Undo2, X } from "lucide-react";
import type { JSX } from "react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchSession, type BoardSession, type Task } from "./api.ts";
import { CommitBar } from "./components/CommitBar.tsx";
import { LiveIndicator } from "./components/LiveIndicator.tsx";
import { Notice } from "./components/Notice.tsx";
import { SavedViews } from "./components/SavedViews.tsx";
import { StoryDrawer } from "./components/StoryDrawer.tsx";
import { TaskDrawer } from "./components/TaskDrawer.tsx";
import { TaskJump } from "./components/TaskJump.tsx";
import { useDragActive } from "./dnd/hooks.ts";
import {
  applyPending,
  emptyFilters,
  filterTasks,
  messageOf,
  taskOnlyQuery,
  useBoard,
  useBoardQuery,
  useFilterOptions,
  type GroupBy,
  type ViewId,
} from "./state.ts";
import { Backlog } from "./views/Backlog.tsx";
import { Kanban } from "./views/Kanban.tsx";
import { Now } from "./views/Now.tsx";
import { Rollup } from "./views/Rollup.tsx";
import { Stories } from "./views/Stories.tsx";

// elkjs is a large layout engine; keep it out of the initial bundle.
const Graph = lazy(async () => ({ default: (await import("./views/Graph.tsx")).Graph }));

const VIEWS = [
  { value: "now", label: "Now" },
  { value: "stories", label: "Roadmap" },
  { value: "rollup", label: "Rollup" },
  { value: "kanban", label: "Board" },
  { value: "backlog", label: "Backlog" },
  { value: "graph", label: "Dependencies" },
] as const;

const GROUPS = [
  { value: "none", label: "No grouping" },
  { value: "project", label: "Group by project" },
  { value: "epic", label: "Group by epic" },
  { value: "repository", label: "Group by repository" },
] as const;

const VIEW_DESCRIPTION: Record<ViewId, string> = {
  now: "See work that is ready, active, or getting stale.",
  stories: "Roadmap grouped by project, epic, and story or enabler.",
  rollup: "Project coverage, activity, and data quality at a glance.",
  kanban: "Move tasks between configured statuses.",
  backlog: "Search and compare all discovered tasks.",
  graph: "Explore dependency paths between tasks.",
};

const COMPOSED = new Set<ViewId>(["now", "stories", "rollup"]);
const TASK_FILTER_LABELS = [
  ["text", "Search"], ["epic", "Epic"], ["repository", "Repository"],
  ["priority", "Priority"], ["status", "Status"], ["readiness", "Readiness"],
] as const;

type StaleKey = "project" | "epic" | "repository";

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function Board({ session }: { readonly session: BoardSession }): JSX.Element {
  // Read before the board, because it is what tells the board to hold a refresh:
  // a corpus reload mid-drag unmounts the card the pointer is holding.
  const dragging = useDragActive();
  const {
    board,
    git,
    loading,
    error,
    touched,
    pending,
    undoable,
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
    addNote,
    undo,
    clearTouched,
  } = useBoard({ paused: dragging, session });
  const { dark, toggle } = useDarkMode();
  const { toast } = useToast();
  const [query, setQuery] = useBoardQuery();
  const [announcement, setAnnouncement] = useState("");
  const [jumpOpen, setJumpOpen] = useState(false);
  const [kanbanConfirmOpen, setKanbanConfirmOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const projectSearchRef = useRef<HTMLInputElement>(null);
  const jumpReturnFocus = useRef<HTMLElement | null>(null);

  const { view, group, filters } = query;
  const options = useFilterOptions(board, filters);
  const activeTaskFilters = TASK_FILTER_LABELS.filter(([key]) => filters[key] !== "");
  const projectTerm = projectSearch.trim().toLocaleLowerCase();
  const visibleProjects = board?.projects.filter((project) =>
    `${project.label} ${project.id}`.toLocaleLowerCase().includes(projectTerm)) ?? [];

  const openView = useCallback((nextView: ViewId) => {
    if (nextView === view && query.task === null && query.story === null && query.focus === null) return;
    setQuery({ view: nextView, task: null, story: null, focus: null }, "push");
  }, [query.focus, query.story, query.task, setQuery, view]);

  const openProject = useCallback((project: string, nextView: ViewId = view) => {
    setQuery({ view: nextView, group: "none", filters: { ...emptyFilters, project }, task: null, story: null, focus: null }, "push");
  }, [setQuery, view]);

  // The optimistic column lives only on the render path; `board` stays byte-faithful
  // to the server so the digest and expected-value guards keep meaning what they say.
  const tasks = useMemo(
    () => (board ? filterTasks(applyPending(board.tasks, pending), filters, board.workflow) : []),
    [board, pending, filters],
  );
  const selectedMatches = useMemo(
    () => (board && query.task ? board.tasks.filter((task) => task.id === query.task) : []),
    [board, query.task],
  );
  const selected = selectedMatches.length === 1 ? selectedMatches[0]! : null;
  const storyDrawerOpen =
    board !== null &&
    query.task === null &&
    query.story !== null &&
    board.stories.some((story) => story.id === query.story);
  const taskLinkProblem = query.task && board
    ? selectedMatches.length === 0
      ? `Task ${query.task} is no longer in the planning corpus.`
      : selectedMatches.length > 1
        ? `Task ${query.task} is defined more than once, so the Board will not pick one.`
        : null
    : null;
  const jumpBlocked =
    selected !== null || kanbanConfirmOpen || storyDrawerOpen;

  const requestTaskJump = useCallback((trigger?: HTMLElement) => {
    const menuOpen = document.querySelector('[role="menu"]') !== null;
    if (jumpBlocked || menuOpen) {
      setAnnouncement(menuOpen
        ? "Close the current menu before opening task jump."
        : "Close the current panel before opening task jump.");
      return;
    }
    jumpReturnFocus.current = trigger ?? (document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null);
    setJumpOpen(true);
  }, [jumpBlocked]);

  const dismissTaskJump = useCallback(() => {
    const trigger = jumpReturnFocus.current;
    jumpReturnFocus.current = null;
    setJumpOpen(false);
    window.requestAnimationFrame(() => trigger?.focus());
  }, []);

  /**
   * The toast and the live region report the same outcome, and both wait for it.
   * Announcing the move as it starts told a screen-reader user the row had
   * changed state when the validator might still refuse it, and the correction
   * only ever arrived as a visual toast.
   */
  const run = useCallback(
    (action: Promise<void>, success: string, announced = success) => {
      action.then(
        () => {
          toast(success, "success");
          setAnnouncement(announced);
        },
        (cause: unknown) => {
          const message = messageOf(cause);
          toast(message, "error");
          setAnnouncement(`Refused: ${message}`);
        },
      );
    },
    [toast],
  );

  const moveStatus = useCallback(
    (task: Task, base: string) => {
      setAnnouncement(`Moving ${task.id} to ${base}`);
      run(setStatus(task, base), `${task.id} → ${base}`, `${task.id} moved to ${base}`);
    },
    [run, setStatus],
  );

  const saveStatus = useCallback(
    async (task: Task, status: string) => setStatus(task, status),
    [setStatus],
  );

  const savePriority = useCallback(
    async (task: Task, priority: string) => setPriority(task, priority),
    [setPriority],
  );

  const saveNote = useCallback(
    async (task: Task, text: string, title?: string) => addNote(task, text, title),
    [addNote],
  );

  const reorder = useCallback(
    (task: Task, toLine: number) => run(moveRow(task, toLine), `${task.id} reordered`),
    [run, moveRow],
  );

  const undoLast = useCallback(() => {
    if (!undoable) return;
    run(undo(), `Reverted ${undoable.taskId}`);
  }, [run, undo, undoable]);

  const openTask = useCallback((task: string | null) => {
    setQuery({ task, story: null }, task === null ? "replace" : "push");
  }, [setQuery]);

  const openCanonicalTask = useCallback((task: string) => {
    setQuery(taskOnlyQuery(task), "push");
  }, [setQuery]);

  const openTaskFromJump = useCallback((taskId: string) => {
    setJumpOpen(false);
    openCanonicalTask(taskId);
  }, [openCanonicalTask]);

  const openGraph = useCallback((task: string) => {
    setQuery({ view: "graph", group: "none", filters: emptyFilters, focus: task, task: null, story: null }, "push");
  }, [setQuery]);

  const showInBacklog = useCallback((task: string) => {
    const matches = board?.tasks.filter((row) => row.id === task) ?? [];
    const inScope = board && matches.length === 1
      && filterTasks(matches, { ...emptyFilters, project: filters.project }, board.workflow).length === 1;
    setQuery({ view: "backlog", group: "none", filters: { ...emptyFilters, project: inScope ? filters.project : "", text: task }, task: null, story: null, focus: null }, "push");
  }, [board, filters.project, setQuery]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
      // Inside a text field, Ctrl+Z belongs to the field. Swallowing it there
      // meant undoing a character in the search box wrote to a ledger instead.
      if (isTextEntry(event.target)) return;
      event.preventDefault();
      undoLast();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undoLast]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      requestTaskJump();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [requestTaskJump]);

  // Browser history can restore a drawer after the jump modal has opened. Keep
  // the shell to one dismissible overlay so Escape never closes two surfaces.
  useEffect(() => {
    if (jumpOpen && jumpBlocked) setJumpOpen(false);
  }, [jumpBlocked, jumpOpen]);

  /**
   * A refresh nobody asked for is the one change a screen-reader user has no
   * other way to notice: the rows simply differ next time they are read.
   */
  useEffect(() => {
    if (refreshedAt === null) return;
    setAnnouncement("The ledgers changed outside this tab; the board has been refreshed.");
  }, [refreshedAt]);

  /**
   * A hash can outlive the value it names: a renamed project, a deleted epic, a
   * repository nobody owns any more. Filtering to it yields an empty board that
   * looks like a bug in the board rather than a stale link.
   */
  const stale = useMemo(() => {
    if (!board) return [];
    const problems: { readonly label: string; readonly key: StaleKey }[] = [];
    if (filters.project && !board.projects.some((project) => project.id === filters.project)) {
      problems.push({ label: `project “${filters.project}”`, key: "project" });
    }
    if (COMPOSED.has(view)) return problems;
    if (filters.epic && !board.documents.some((document) => document.path === filters.epic)) {
      problems.push({ label: `epic “${filters.epic}”`, key: "epic" });
    }
    if (
      filters.repository &&
      !board.tasks.some((task) => task.repositories.includes(filters.repository))
    ) {
      problems.push({ label: `repository “${filters.repository}”`, key: "repository" });
    }
    return problems;
  }, [board, filters, view]);

  const scopeLabel = board?.projects.find((project) => project.id === filters.project)?.label;
  const scopedTasks = useMemo(
    () =>
      board
        ? filterTasks(board.tasks, { ...emptyFilters, project: filters.project }, board.workflow)
        : [],
    [board, filters.project],
  );

  return (
    <div className="app-shell ux-portfolio mx-auto flex min-h-screen max-w-[104rem] flex-col gap-4 px-4 pb-6 sm:px-6">
      {/* The board scrolls both ways underneath; the controls that steer it stay. */}
      <header className="app-header toolbar sticky top-0 z-30 -mx-4 border-b border-ui-border bg-ui-bg/90 px-4 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="app-header-main">
          <div className="app-brand">
            <span className="app-mark" aria-hidden />
            <div>
              <p className="app-eyebrow">Local Markdown</p>
              <h1>PlanOps Board</h1>
            </div>
          </div>
          <div className="app-actions">
            <Button
              variant="ghost"
              size="sm"
              className="min-h-11"
              icon={<Search size={15} />}
              aria-haspopup="dialog"
              disabled={jumpBlocked}
              title={jumpBlocked ? "Close the current panel before jumping to another task." : undefined}
              onClick={(event) => requestTaskJump(event.currentTarget)}
            >
              Jump to task
            </Button>
            {session.capabilities.localWrites && undoable ? (
              <Button variant="ghost" size="sm" icon={<Undo2 size={15} />} onClick={undoLast}>
                Undo {undoable.taskId}
              </Button>
            ) : null}
            <LiveIndicator status={live} behind={behind} refreshedAt={refreshedAt} />
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw size={15} />}
              onClick={() => void reload()}
            >
              Reload
            </Button>
            <DarkModeToggle dark={dark} onToggle={toggle} />
          </div>
        </div>
        <div className="app-navigation">
          <div className="view-tabs">
            <SegmentedControl
              options={VIEWS}
              value={view}
              onChange={(next) => openView(next as ViewId)}
              ariaLabel="Board view"
            />
          </div>
          <SavedViews query={query} sourceSha={session.sourceSha} onApply={(patch) => setQuery({ ...patch, task: null, story: null, focus: null }, "push")} />
        </div>
        <details className="source-freshness" data-testid="source-freshness">
          <summary>
            Source {session.sourceRef.replace("refs/heads/", "")} at {session.sourceSha.slice(0, 7)}
          </summary>
          <div>
            <span className="mono">{session.sourceSha}</span>
            <span>
              Built <time dateTime={session.builtAt}>{new Date(session.builtAt).toLocaleString()}</time>
            </span>
            <span>
              {checkedAt === null
                ? "Not refreshed in this session"
                : `Last checked ${new Date(checkedAt).toLocaleTimeString()}`}
            </span>
          </div>
        </details>
      </header>

      <aside className="portfolio-rail" aria-label="Project explorer">
        <div className="portfolio-rail-heading">
          <span className="view-eyebrow">Navigate</span>
          <strong>Projects</strong>
          <p>Choose a project, then follow its work through every view.</p>
        </div>
        <div className="portfolio-search">
          <Search size={16} aria-hidden />
          <label htmlFor="portfolio-project-search" className="sr-only">Find project</label>
          <input id="portfolio-project-search" ref={projectSearchRef} type="search" value={projectSearch}
            placeholder="Find project…" onChange={(event) => setProjectSearch(event.target.value)} />
          {projectSearch ? <button type="button" className="focus-ring" aria-label="Clear project search"
            onClick={() => { setProjectSearch(""); projectSearchRef.current?.focus(); }}><X size={16} aria-hidden /></button> : null}
        </div>
        {projectTerm && board ? <p className="portfolio-search-count" role="status">
          {visibleProjects.length} of {board.projects.length} projects
        </p> : null}
        <div className="portfolio-projects">
          <button type="button" className="portfolio-project focus-ring"
            aria-current={filters.project === "" ? "true" : undefined}
            onClick={() => openProject("")}>
            <span className="portfolio-project-name">All projects</span>
            <span className="portfolio-project-count">{board?.tasks.length ?? 0} tasks</span>
          </button>
          {board ? visibleProjects.map((project) => {
            const projectTasks = board.tasks.filter((task) => task.project === project.id || task.projects.includes(project.id));
            const startable = projectTasks.filter((task) => task.readiness === "startable").length;
            return <div className="portfolio-project-row" key={project.id}>
              <button type="button" className="portfolio-project focus-ring"
                aria-current={filters.project === project.id ? "true" : undefined}
                onClick={() => openProject(project.id)}>
                <span className="portfolio-project-name">{project.label}</span>
                <span className="portfolio-project-count">{projectTasks.length} tasks · {startable} ready</span>
              </button>
              <DropdownMenu align="end" trigger={<span className="portfolio-project-more" aria-label={`Open ${project.label} in a view`}><MoreHorizontal size={16} /></span>}
                groups={[{ label: project.label, items: [
                  { id: "roadmap", label: "Open roadmap", onClick: () => openProject(project.id, "stories") },
                  { id: "board", label: "Open board", onClick: () => openProject(project.id, "kanban") },
                  { id: "deps", label: "Open dependencies", onClick: () => openProject(project.id, "graph") },
                ] }]} />
            </div>;
          }) : null}
          {board && projectTerm && visibleProjects.length === 0 ? <p className="portfolio-project-empty">
            No projects match “{projectSearch.trim()}”.
          </p> : null}
        </div>
      </aside>

      {error ? (
        <Notice tone="blocked" title="Could not load the ledgers">
          {error}
        </Notice>
      ) : null}

      {taskLinkProblem ? (
        <Notice tone="blocked" title="This task link needs attention">
          {taskLinkProblem}
        </Notice>
      ) : null}

      {stale.length > 0 ? (
        <Notice tone="deferred" title="This link filters on something that no longer exists">
          <p>
            No row matches {stale.map((problem) => problem.label).join(" or ")}, so the board below
            is empty for that reason rather than because the work is done.
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="mt-1"
            onClick={() => {
              const cleared: { -readonly [K in StaleKey]?: string } = {};
              for (const problem of stale) cleared[problem.key] = "";
              setQuery({ filters: cleared });
            }}
          >
            Clear {stale.length === 1 ? "it" : "them"}
          </Button>
        </Notice>
      ) : null}

      {git ? (
        <CommitBar
          git={git}
          touched={touched}
          undoable={undoable}
          settling={loading || writing || behind}
          onUndo={undoLast}
          onRefresh={reload}
          onCommitted={() => {
            clearTouched();
            return reload();
          }}
        />
      ) : null}

      <div className="view-intro">
        <div>
          <p className="view-eyebrow">{VIEWS.find((item) => item.value === view)?.label}</p>
          <h2 className="ux-view-title">{scopeLabel ?? "All projects"}</h2>
          <p className="view-description">{VIEW_DESCRIPTION[view]}</p>
        </div>
        <div className="portfolio-view-actions" aria-label="Project views">
          <button type="button" className="focus-ring" aria-current={view === "stories" ? "page" : undefined} onClick={() => openView("stories")}>Roadmap</button>
          <button type="button" className="focus-ring" aria-current={view === "kanban" ? "page" : undefined} onClick={() => openView("kanban")}>Board</button>
          <button type="button" className="focus-ring" aria-current={view === "backlog" ? "page" : undefined} onClick={() => openView("backlog")}>Tasks</button>
        </div>
        {COMPOSED.has(view) ? (
          <span className="tabular view-count">
            {scopedTasks.length} {scopedTasks.length === 1 ? "task" : "tasks"}
          </span>
        ) : null}
      </div>

      {COMPOSED.has(view) && activeTaskFilters.length > 0 ? (
        <section className="paused-filters" aria-label="Paused task filters">
          <div>
            <h3>Task filters are paused</h3>
            <p>This overview uses project scope. These filters resume in Board, Backlog and Dependencies.</p>
            <div className="paused-filter-chips">
              {activeTaskFilters.map(([key, label]) => (
                <button type="button" key={key} className="focus-ring" aria-label={`Remove ${label.toLowerCase()} filter: ${filters[key]}`}
                  onClick={() => setQuery({ filters: { [key]: "" } })}>
                  <span>{label}: {filters[key]}</span><X size={12} aria-hidden />
                </button>
              ))}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => openView("backlog")}>View filtered tasks</Button>
            <Button size="sm" variant="ghost" onClick={() => setQuery({ filters: { ...emptyFilters, project: filters.project } })}>Clear task filters</Button>
          </div>
        </section>
      ) : null}

      {/* Grouping and filters refine the active work view. Now, Stories and
       * Rollup are deliberately composed overviews that answer a question
       * rather than list rows, so controls that do nothing stay out. */}
      {!COMPOSED.has(view) ? (
        <div className="workspace-toolbar toolbar">
          {view === "kanban" ? (
            <div className="w-44">
              <Select
                aria-label="Group by"
                value={group}
                onChange={(event) => setQuery({ group: event.target.value as GroupBy })}
              >
                {GROUPS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          <button
            type="button"
            role="switch"
            aria-checked={filters.readiness === "startable"}
            onClick={() =>
              setQuery({
                filters: { readiness: filters.readiness === "startable" ? "" : "startable" },
              })
            }
            className={`focus-ring inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors ${
              filters.readiness === "startable"
                ? "border-ui-accent/40 bg-ui-accent/[0.08] text-ui-accent"
                : "border-ui-border text-ui-text-muted hover:text-ui-text"
            }`}
          >
            <Check
              size={13}
              className={filters.readiness === "startable" ? "" : "opacity-30"}
            />
            Startable now
          </button>
          {filters.readiness === "waiting" || filters.readiness === "needs-gate-check" ? (
            <div className="paused-filter-chips">
              <button type="button" className="focus-ring" aria-label={`Remove readiness filter: ${filters.readiness}`}
                onClick={() => setQuery({ filters: { readiness: "" } })}>
                <span>Readiness: {filters.readiness}</span><X size={12} aria-hidden />
              </button>
            </div>
          ) : null}
          <FilterBar
            search={{
              value: filters.text,
              onChange: (text) => setQuery({ filters: { text } }),
              placeholder: "Search ID, outcome, owner…",
            }}
            filters={[
              {
                id: "epic",
                label: "Epic",
                options: options.epics,
                value: filters.epic,
                onChange: (epic) => setQuery({ filters: { epic } }),
              },
              {
                id: "repository",
                label: "Repository",
                options: options.repositories,
                value: filters.repository,
                onChange: (repository) => setQuery({ filters: { repository } }),
              },
              {
                id: "priority",
                label: "Priority",
                options: options.priorities,
                value: filters.priority,
                onChange: (priority) => setQuery({ filters: { priority } }),
              },
              {
                id: "status",
                label: "Status",
                options: options.statuses,
                value: filters.status,
                onChange: (status) => setQuery({ filters: { status } }),
              },
            ]}
            // Preserve the header's scope when clearing row-level filters.
            onClear={() => setQuery({ filters: { ...emptyFilters, project: filters.project } })}
          />
        </div>
      ) : null}

      <main className="flex-1">
        {loading && !board ? (
          <Skeleton height="6rem" />
        ) : board ? (
          <>
            {view === "now" ? (
              <Now
                board={board}
                tasks={scopedTasks}
                lastChanged={lastChanged}
                onSelectTask={openTask}
                onOpenGraph={openGraph}
                onShowInBacklog={showInBacklog}
                onOpenBacklog={() => openView("backlog")}
              />
            ) : null}
            {view === "stories" ? (
              <Stories
                board={board}
                tasks={scopedTasks}
                onSelectStory={(story) => setQuery({ story }, "push")}
                onOpenBacklog={() => openView("backlog")}
              />
            ) : null}
            {view === "rollup" ? (
              <Rollup
                board={board}
                tasks={scopedTasks}
                lastChanged={lastChanged}
                onOpenProject={(project) =>
                  openProject(project, "kanban")
                }
                onOpenEpic={(file) =>
                  setQuery({ view: "kanban", filters: { ...emptyFilters, epic: file }, focus: null }, "push")
                }
                onOpenRepository={(repository) =>
                  setQuery({ view: "kanban", filters: { ...emptyFilters, repository }, focus: null }, "push")
                }
                onOpenStartable={() =>
                  setQuery({
                    view: "kanban",
                    filters: { ...emptyFilters, project: filters.project, readiness: "startable" },
                    focus: null,
                  }, "push")
                }
                onSelectTask={openTask}
              />
            ) : null}
            {view === "kanban" ? (
              <Kanban
                board={board}
                tasks={tasks}
                groupBy={group}
                pendingIds={new Set(pending.keys())}
                selectedId={query.task}
                onSelectTask={openTask}
                onMoveStatus={moveStatus}
                onOpenGraph={openGraph}
                onShowInBacklog={showInBacklog}
                onOverlayChange={setKanbanConfirmOpen}
                editable={session.capabilities.localWrites}
              />
            ) : null}
            {view === "backlog" ? (
              <Backlog
                board={board}
                tasks={tasks}
                onSelectTask={openTask}
                onOpenGraph={openGraph}
                onShowInBacklog={showInBacklog}
                onReorder={reorder}
                lastChanged={lastChanged}
                reorderable={session.capabilities.localWrites && filters.epic !== ""}
              />
            ) : null}
            {view === "graph" ? (
              <Suspense fallback={<Skeleton height="24rem" />}>
                <Graph
                  board={board}
                  tasks={tasks}
                  selectedId={query.focus ?? query.task}
                  onSelectTask={openTask}
                  onFocusTask={(focus) => setQuery({ focus, task: null, story: null }, "push")}
                  onOpenGraph={openGraph}
                  onShowInBacklog={showInBacklog}
                />
              </Suspense>
            ) : null}
          </>
        ) : null}
      </main>

      {/* Native drag reports nothing to a screen reader; every move says so here. */}
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      {board && !jumpOpen ? (
        <TaskDrawer
          task={selected}
          board={board}
          onClose={() => setQuery({ task: null })}
          sourceRef={session.sourceRef}
          sourceSha={session.sourceSha}
          mode={session.capabilities.localWrites
            ? {
                kind: "local",
                onSaveStatus: saveStatus,
                onSavePriority: savePriority,
                onAddNote: saveNote,
              }
            : { kind: "viewer" }}
          onSelectTask={openTask}
          onOpenGraph={openGraph}
        />
      ) : null}

      <TaskJump
        open={jumpOpen}
        tasks={board?.tasks ?? []}
        onDismiss={dismissTaskJump}
        onOpenTask={openTaskFromJump}
      />

      {/* Opening a member row from a story hands over to the task drawer, which
       * is the one that can edit; the story has nothing of its own to write. */}
      {board && storyDrawerOpen && !jumpOpen ? (
        <StoryDrawer
          storyId={query.story}
          board={board}
          onClose={() => setQuery({ story: null })}
          onSelectTask={openTask}
        />
      ) : null}
    </div>
  );
}

export function App(): JSX.Element {
  const [session, setSession] = useState<BoardSession | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    void fetchSession().then(setSession, (error: unknown) => setFailure(String(error)));
  }, []);

  return (
    <ToastProvider>
      {session ? (
        <Board session={session} />
      ) : failure ? (
        <main className="mx-auto max-w-xl p-6">
          <Notice tone="blocked" title="Could not start the board">{failure}</Notice>
        </main>
      ) : (
        <main className="mx-auto max-w-xl p-6"><Skeleton height="8rem" /></main>
      )}
    </ToastProvider>
  );
}
