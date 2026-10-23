// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WORKFLOW } from "../shared/config.ts";
import * as api from "../src/api.ts";
import * as state from "../src/state.ts";
import type { Board, Story, Task } from "../src/api.ts";
import { App } from "../src/App.tsx";
import { storyViewsInScope } from "../src/stories.ts";
import { Stories } from "../src/views/Stories.tsx";

function task(id: string, partial: Partial<Task> = {}): Task {
  return { id, file: "plans/moon.md", epic: "Moon", section: null, title: id, line: 1, status: "Ready", statusBase: "Ready",
    statusQualifier: "", statusValid: true, priority: "P1", owners: [], repositories: [], project: "orbit", projects: ["orbit"],
    dependencies: [], dependencyResidue: [], outcome: "Observe", raw: {}, statusCell: null, priorityCell: null, outcomeCell: null,
    readiness: "startable", writable: true, storyId: null, subtasks: [], qwen3CoderNextReady: false, executionReadiness: "unassessed",
    packetMetadata: { workKind: null, estimatedChangedLoc: null, sizeException: null, splitTaskIds: [], files: [], issues: [] },
    workKind: null, estimatedChangedLoc: null, sizeException: null, readinessCheckedAt: null, executionBlockers: [], ...partial };
}
function story(id: string, taskIds: readonly string[], partial: Partial<Story> = {}): Story {
  return { id, taskIds, file: "plans/moon.md", epic: "Moon", title: id, kind: "story", role: "observer",
    outcome: `Observe ${id}`, soThat: "The fictional sky is understood", demo: null, headingLine: 10, ...partial };
}
function fixture(): Board {
  return { generatedAt: "2026-08-20T12:00:00Z", revision: "a".repeat(64), planRevision: "a".repeat(64), workflow: DEFAULT_WORKFLOW,
    qwenReadiness: { status: "missing", schemaVersion: null, auditBaseCommit: null, capturedAt: null, candidateCount: 0, manifestSha256: null, error: null },
    tasks: [task("ORB-001"), task("ORB-002"), task("SUN-001", { project: "sun", projects: ["sun"] })],
    taskTables: [],
    stories: [story("ORB-S01", ["ORB-001"]), story("ORB-S02", ["ORB-002"], { file: "plans/star.md", kind: "enabler", role: null }), story("SUN-S01", ["SUN-001"])],
    documents: ["plans/moon.md", "plans/star.md"].map((path) => ({ path, title: "Shared sky", writable: true, sha256: "a".repeat(64), taskCount: 999,
      vocabulary: { bases: DEFAULT_WORKFLOW.statusOrder, source: "configured" } })),
    projects: ["orbit", "sun"].map((id) => ({ id, label: id === "orbit" ? "Observatory" : "Solar", scope: "product", primaryCount: 999, taskCount: 999, parked: null })),
    details: [], findings: [], issues: [], statusBases: DEFAULT_WORKFLOW.statusOrder };
}
const onSelectStory = vi.fn(), onOpenBacklog = vi.fn();
const props = (board = fixture(), tasks = board.tasks) => ({ board, tasks, onSelectStory, onOpenBacklog });
const group = (name: string) => screen.getByRole("group", { name });
const summary = (element: HTMLElement) => element.querySelector("summary")!;
function toggle(element: HTMLElement, open: boolean) { act(() => { element.toggleAttribute("open", open); fireEvent(element, new Event("toggle")); }); }
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("scoped roadmap hierarchy", () => {
  it("groups same-H1 documents separately beneath scoped projects with complete collapsed summaries", () => {
    const board = fixture(); render(<Stories {...props(board)} />);
    const project = group("Project Observatory"), epics = within(project).getAllByRole("group", { name: /^Epic/ });
    expect(epics).toHaveLength(2); expect(summary(project)).toHaveTextContent("2 epics"); expect(summary(project)).toHaveTextContent("2 outcomes");
    expect(epics.map((epic) => summary(epic).textContent)).toEqual([expect.stringContaining("plans/moon.md"), expect.stringContaining("plans/star.md")]);
    expect(summary(epics[0]!)).toHaveTextContent("Shared sky"); expect(summary(epics[1]!)).toHaveTextContent("Shared sky");
    const outcome = within(epics[0]!).getByRole("group", { name: /^Story ORB-S01/ });
    for (const text of ["story", "As a observer", "Observe ORB-S01", "Full group: 0 of 1 complete", "in flight", "next ORB-001"]) expect(summary(outcome)).toHaveTextContent(text);
    expect(outcome).not.toHaveAttribute("open"); expect(within(outcome).getByRole("button", { name: /^Open story ORB-S01/ })).not.toBeVisible();
    toggle(outcome, true); fireEvent.click(within(outcome).getByRole("button", { name: /^Open story ORB-S01/ }));
    expect(onSelectStory).toHaveBeenCalledExactlyOnceWith("ORB-S01");
    expect(screen.getByText(/3 stories over 3 of 3 rows/)).toBeVisible(); expect(group("Project Solar")).toBeVisible();
  });

  it("keeps native disclosures independent with no actions or exclusive/custom keyboard semantics in summaries", () => {
    const { container } = render(<Stories {...props()} />);
    const project = group("Project Observatory"), solar = group("Project Solar"); toggle(project, false); expect(solar).toHaveAttribute("open");
    toggle(project, true); const outcomes = within(project).getAllByRole("group", { name: /^(Story|Enabler)/ });
    outcomes.forEach((outcome) => toggle(outcome, true)); toggle(outcomes[0]!, false); expect(outcomes[1]).toHaveAttribute("open");
    for (const disclosure of container.querySelectorAll("details")) {
      expect(disclosure.querySelectorAll(":scope > summary")).toHaveLength(1); expect(disclosure).not.toHaveAttribute("name");
      const control = disclosure.querySelector(":scope > summary")!; expect(control.querySelectorAll("button,a,details")).toHaveLength(0);
      expect(control).not.toHaveAttribute("aria-expanded"); expect(control).not.toHaveAttribute("tabindex"); expect(control).toHaveClass("focus-ring");
    }
    expect(container.querySelector('[role="tree"], [role="treeitem"]')).toBeNull(); expect(onSelectStory).not.toHaveBeenCalled();
  });

  it.each(["blank", "absent"])("uses stable label fallbacks for %s project and document summaries", (kind) => {
    const board = fixture(); render(<Stories {...props({ ...board, projects: kind === "absent" ? [] : board.projects.map((p) => ({ ...p, label: "  " })),
      documents: kind === "absent" ? [] : board.documents.map((d) => ({ ...d, title: "  ", taskCount: 0 })) })} />);
    expect(group("Project orbit")).toBeVisible(); expect(summary(group("Epic plans/moon.md in orbit"))).toHaveTextContent("plans/moon.md");
  });

  it("preserves parking order and keeps zero/missing-member stories despite absent document rows", () => {
    const board = fixture(); const parked = { ...board.projects[0]!, parked: { since: "2026-08-01", reason: "Observe later" } };
    render(<Stories {...props({ ...board, projects: [parked, board.projects[1]!], documents: [],
      stories: [...board.stories, story("VOID-S01", []), story("VOID-S02", ["VOID-999"], { file: "plans/void.md" })] })} />);
    const projects = screen.getAllByRole("group", { name: /^Project/ }); expect(projects.at(-1)).toBe(group("Project Observatory"));
    expect(summary(group("Project Observatory"))).toHaveTextContent("parked 2026-08-01");
    const unassigned = group("Project unassigned"); expect(summary(unassigned)).toHaveTextContent("2 outcomes");
    expect(summary(within(unassigned).getByRole("group", { name: /^Story VOID-S01/ }))).toHaveTextContent("0 of 0 complete");
    expect(summary(within(unassigned).getByRole("group", { name: /^Story VOID-S02/ }))).toHaveTextContent("1 unknown");
  });

  it("preserves cross-project full-group progress while counts and backlog actions describe current row scope", () => {
    const board = fixture(), done = task("SUN-001", { project: "sun", projects: ["sun"], statusBase: "Complete", readiness: null });
    const scoped = [board.tasks[0]!, task("ORB-999")]; const cross = { ...board, tasks: [...scoped, done], stories: [story("ORB-S01", [done.id, "ORB-001"])] };
    render(<Stories {...props(cross, scoped)} />); const project = group("Project Solar");
    expect(summary(project)).toHaveTextContent("1 outcome"); expect(within(project).getByRole("progressbar")).toHaveAttribute("aria-valuemax", "2");
    expect(summary(within(project).getByRole("group", { name: /^Story/ }))).toHaveTextContent("Full group: 1 of 2 complete");
    expect(screen.getByText(/1 story over 1 of 2 rows/)).toBeVisible(); expect(screen.getByText(/current project scope and row filters remain in effect/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open backlog" })); expect(onOpenBacklog).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/deliberately optional|unassigned-only/)).not.toBeInTheDocument();
  });

  it("keeps duplicate occurrences, ordered views, unique DOM references and escaped source context", () => {
    const board = fixture(), hostile = "<img src=x onerror=alert(1)>";
    const stories = [story("ORB-S01", ["ORB-001"], { headingLine: 20, outcome: hostile }), ...board.stories];
    const input = { ...board, stories }, before = JSON.stringify(input); const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { container } = render(<Stories {...props(input)} />); const project = group("Project Observatory");
    const expected = storyViewsInScope(input, input.tasks).filter((v) => v.projects[0] === "orbit" && v.story.file === "plans/moon.md");
    const outcomes = within(project).getAllByRole("group", { name: /^Story ORB-S01/ }); expect(outcomes.map((node) => node.getAttribute("aria-label")))
      .toEqual(expected.map((v) => `Story ${v.story.id} from ${v.story.file} line ${v.story.headingLine}`));
    expect(within(project).getByText(hostile, { exact: false })).toBeVisible(); expect(container.querySelector("img")).toBeNull();
    const ids = [...container.querySelectorAll("[id]")].map((node) => node.id); expect(new Set(ids).size).toBe(ids.length);
    expect(errors).not.toHaveBeenCalled(); expect(JSON.stringify(input)).toBe(before); errors.mockRestore();
  });

  it("retains disclosure and focused DOM identity across label, count, order and revision refresh", () => {
    const board = fixture(), { rerender } = render(<Stories {...props(board)} />), project = group("Project Observatory");
    const epic = within(project).getAllByRole("group", { name: /^Epic/ })[0]!, outcome = within(epic).getByRole("group", { name: /^Story/ });
    toggle(outcome, true); const action = within(outcome).getByRole("button", { name: /^Open story/ }); action.focus();
    const refreshed = { ...board, revision: "b".repeat(64), projects: board.projects.map((p) => ({ ...p, label: p.id })),
      documents: board.documents.map((d) => ({ ...d, title: "Renamed sky" })), stories: [story("ORB-S00", ["ORB-001"]), ...board.stories] };
    rerender(<Stories {...props(refreshed)} />); expect(group("Project orbit")).toBe(project); expect(outcome).toHaveAttribute("open"); expect(action).toHaveFocus();
    expect(within(project).getByRole("group", { name: /^Story ORB-S01/ })).toBe(outcome); expect(summary(epic)).toHaveTextContent("Renamed sky");
    toggle(epic, false); summary(epic).focus(); rerender(<Stories {...props({ ...refreshed, revision: "c".repeat(64) })} />);
    expect(epic).not.toHaveAttribute("open"); expect(summary(epic)).toHaveFocus();
  });

  it("keeps long hostile project and epic labels and source paths as complete escaped text", () => {
    const board = fixture(), label = "<img src=x>" + "Observation".repeat(50), path = `plans/${"observatory/".repeat(50)}sky.md`;
    const input = { ...board, projects: board.projects.map((p) => ({ ...p, label })),
      documents: [{ ...board.documents[0]!, path, title: label }], stories: [story("ORB-S01", ["ORB-001"], { file: path })] };
    const { container } = render(<Stories {...props(input)} />), project = group(`Project ${label}`), epic = group(`Epic ${path} in orbit`);
    expect(summary(project)).toHaveTextContent(label); expect(summary(epic)).toHaveTextContent(label);
    expect(within(epic).getByText(path, { exact: true }).textContent).toBe(path);
    expect(within(epic).getByText(`${path} line 10`, { exact: true }).textContent).toBe(`${path} line 10`);
    expect(container.querySelectorAll("img,script,a")).toHaveLength(0);
  });

  it("explains an empty scope without fabricating groups", () => {
    render(<Stories {...props(fixture(), [])} />); expect(screen.queryAllByRole("group")).toHaveLength(0);
    expect(screen.getByText(/No story blocks in this scope yet/)).toBeVisible(); expect(screen.getByText(/0 stories over 0 of 0 rows/)).toBeVisible();
  });
});

describe("inline roadmap authoring", () => {
  const table = { file: "plans/moon.md", headerLine: 14,
    headers: ["ID", "Priority", "Status", "Dependencies", "Repository / owner", "Required outcome"] };
  const writable = () => ({ ...fixture(), taskTables: [table],
    tasks: [task("ORB-001", { storyId: "ORB-S01", statusCell: { file: "plans/moon.md", line: 16, column: 2 },
      subtasks: [{ id: "ORB-001.1", parentTaskId: "ORB-001", title: "Inspect the moon", owner: "alex", done: false }] }),
      task("ORB-002"), task("SUN-001", { project: "sun", projects: ["sun"] })] });
  const openStory = () => toggle(group("Story ORB-S01 from plans/moon.md line 10"), true);

  it("shows a confirmed story, linked task, two subtasks and one toggle only after each refresh", async () => {
    let confirm: () => void = () => { throw new Error("No write is pending"); };
    const messages = vi.fn();
    const onAuthor = vi.fn(async (_file: string, operation: api.AuthorOperation) => new Promise<boolean>((resolve) => {
      confirm = () => {
        setBoard((current) => {
          const revision = String.fromCharCode(current.revision.charCodeAt(0) + 1).repeat(64);
          if (operation.operation === "create.story") return { ...current, revision,
            stories: [...current.stories, story(operation.id, [], { title: operation.title, outcome: operation.outcome,
              soThat: operation.soThat, role: operation.role ?? null })] };
          if (operation.operation === "create.task") return { ...current, revision,
            stories: current.stories.map((entry) => entry.id === operation.storyId ? { ...entry, taskIds: [...entry.taskIds, operation.id] } : entry),
            tasks: [...current.tasks, task(operation.id, { title: operation.title, storyId: operation.storyId,
              status: operation.cells["Status"] ?? "Ready", statusBase: operation.cells["Status"] ?? "Ready" })] };
          return { ...current, revision, tasks: current.tasks.map((entry) => entry.id === operation.taskId ? { ...entry,
            subtasks: operation.operation === "create.subtask"
              ? [...entry.subtasks, { id: operation.id, parentTaskId: entry.id, title: operation.title,
                owner: operation.owner ?? null, done: false }]
              : entry.subtasks.map((subtask) => subtask.id === operation.id ? { ...subtask, done: !subtask.done } : subtask),
          } : entry) };
        });
        resolve(true);
      };
    }));
    let setBoard!: (updater: (current: Board) => Board) => void;
    function Harness() {
      const [board, update] = useState<Board>(writable);
      setBoard = update;
      return <Stories {...props(board)} editable onAuthor={onAuthor} onRefresh={async () => true} onMessage={messages} />;
    }
    render(<Harness />);
    const accept = async () => { act(() => confirm()); await waitFor(() => expect(onAuthor).toHaveBeenCalledTimes(messages.mock.calls.length)); };

    fireEvent.click(within(group("Epic plans/moon.md in orbit")).getByRole("button", { name: "Add story in plans/moon.md" }));
    const storyForm = screen.getByRole("form", { name: "Create story in plans/moon.md" });
    fireEvent.change(within(storyForm).getByLabelText("Story ID"), { target: { value: "ORB-S03" } });
    fireEvent.change(within(storyForm).getByLabelText("Title"), { target: { value: "Observe the dawn" } });
    fireEvent.change(within(storyForm).getByLabelText("Outcome"), { target: { value: "I can observe the dawn" } });
    fireEvent.change(within(storyForm).getByLabelText("So that"), { target: { value: "I can choose a clear sky" } });
    fireEvent.click(within(storyForm).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onAuthor).toHaveBeenCalledExactlyOnceWith("plans/moon.md", {
      operation: "create.story", id: "ORB-S03", title: "Observe the dawn", kind: "story",
      outcome: "I can observe the dawn", soThat: "I can choose a clear sky",
    }));
    expect(screen.queryByRole("group", { name: /^Story ORB-S03/ })).not.toBeInTheDocument();
    await accept();
    await waitFor(() => expect(screen.queryByRole("form", { name: "Create story in plans/moon.md" })).not.toBeInTheDocument());
    let outcome = group("Story ORB-S03 from plans/moon.md line 10");
    toggle(outcome, true);
    fireEvent.click(within(outcome).getByRole("button", { name: "Add task to ORB-S03" }));
    const taskForm = screen.getByRole("form", { name: "Create task for ORB-S03" });
    fireEvent.change(within(taskForm).getByLabelText("Task ID"), { target: { value: "ORB-003" } });
    fireEvent.change(within(taskForm).getByLabelText("Title"), { target: { value: "Map the dawn" } });
    fireEvent.change(within(taskForm).getByLabelText("Status"), { target: { value: "Ready" } });
    fireEvent.click(within(taskForm).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onAuthor).toHaveBeenCalledTimes(2));
    expect(onAuthor).toHaveBeenNthCalledWith(2, "plans/moon.md", { operation: "create.task", id: "ORB-003",
      storyId: "ORB-S03", title: "Map the dawn", tableHeaderLine: 14,
      cells: { Priority: "", Status: "Ready", Dependencies: "", "Repository / owner": "", "Required outcome": "" } });
    expect(within(outcome).queryByText("ORB-003")).not.toBeInTheDocument();
    await accept();
    await waitFor(() => expect(screen.queryByRole("form", { name: "Create task for ORB-S03" })).not.toBeInTheDocument());
    outcome = group("Story ORB-S03 from plans/moon.md line 10");
    expect(within(outcome).getByText("Map the dawn")).toBeVisible();

    for (const [index, title] of [[1, "Record sunrise"], [2, "Check horizon"]] as const) {
      fireEvent.click(within(outcome).getByRole("button", { name: "Add subtask to ORB-003" }));
      const form = screen.getByRole("form", { name: "Create subtask for ORB-003" });
      fireEvent.change(within(form).getByLabelText("Subtask ID"), { target: { value: `ORB-003.${index}` } });
      fireEvent.change(within(form).getByLabelText("Title"), { target: { value: title } });
      fireEvent.click(within(form).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(onAuthor).toHaveBeenCalledTimes(2 + index));
      expect(onAuthor).toHaveBeenNthCalledWith(2 + index, "plans/moon.md", { operation: "create.subtask",
        taskId: "ORB-003", id: `ORB-003.${index}`, title });
      expect(within(outcome).queryByRole("checkbox", { name: new RegExp(`ORB-003\\.${index} ${title}`) })).not.toBeInTheDocument();
      await accept();
      await waitFor(() => expect(form).not.toBeInTheDocument());
      expect(within(outcome).getByRole("checkbox", { name: new RegExp(`ORB-003\\.${index} ${title}`) })).not.toBeChecked();
    }
    const first = within(outcome).getByRole("checkbox", { name: /ORB-003\.1 Record sunrise/ });
    const second = within(outcome).getByRole("checkbox", { name: /ORB-003\.2 Check horizon/ });
    fireEvent.click(first);
    await waitFor(() => expect(onAuthor).toHaveBeenCalledTimes(5));
    expect(onAuthor).toHaveBeenNthCalledWith(5, "plans/moon.md", { operation: "toggle.subtask",
      taskId: "ORB-003", id: "ORB-003.1" });
    expect(first).not.toBeChecked();
    expect(second).not.toBeChecked();
    await accept();
    await waitFor(() => expect(first).toBeChecked());
    expect(second).not.toBeChecked();
    expect(messages).toHaveBeenCalledTimes(5);
  });

  it("offers an explicit writable file when no story lane exists", () => {
    const board = { ...writable(), stories: [] };
    const onAuthor = vi.fn(async () => true);
    render(<Stories {...props(board)} editable onAuthor={onAuthor} />);
    expect(screen.queryByRole("group", { name: /^Epic/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Add story/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Story file"), { target: { value: "plans/moon.md" } });
    expect(screen.getByRole("button", { name: "Add story in plans/moon.md" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Add story in plans/star.md" })).not.toBeInTheDocument();
  });

  it("refuses blank story sentence fields, then sends one explicit story operation and restores focus", async () => {
    const onAuthor = vi.fn(async () => true);
    render(<Stories {...props(writable())} editable onAuthor={onAuthor} onRefresh={async () => true} />);
    const trigger = within(group("Epic plans/moon.md in orbit")).getByRole("button", { name: "Add story in plans/moon.md" });
    fireEvent.click(trigger);
    const form = screen.getByRole("form", { name: "Create story in plans/moon.md" });
    fireEvent.change(within(form).getByLabelText("Story ID"), { target: { value: "ORB-S03" } });
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Observe the dawn" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    expect(within(form).getByText("Outcome is required.")).toBeVisible();
    expect(within(form).getByText("So that is required.")).toBeVisible();
    expect(onAuthor).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText("Outcome"), { target: { value: "I can compare the dawn" } });
    fireEvent.change(within(form).getByLabelText("So that"), { target: { value: "I choose a route" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onAuthor).toHaveBeenCalledExactlyOnceWith("plans/moon.md", {
      operation: "create.story", id: "ORB-S03", title: "Observe the dawn", kind: "story",
      outcome: "I can compare the dawn", soThat: "I choose a route",
    }));
    await waitFor(() => expect(form).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("group", { name: /^Story ORB-S03/ })).not.toBeInTheDocument();
  });

  it("requires a file-local table choice and preserves task input after a server conflict", async () => {
    const board = { ...writable(), taskTables: [table, { ...table, headerLine: 30 }] };
    const onAuthor = vi.fn().mockRejectedValueOnce(new api.ApiError(409, { error: "Document changed", kind: "conflict" })).mockResolvedValueOnce(true);
    const onRefresh = vi.fn(async () => true);
    render(<Stories {...props(board)} editable onAuthor={onAuthor} onRefresh={onRefresh} />);
    openStory();
    fireEvent.click(screen.getByRole("button", { name: "Add task to ORB-S01" }));
    const form = screen.getByRole("form", { name: "Create task for ORB-S01" });
    fireEvent.change(within(form).getByLabelText("Task ID"), { target: { value: "ORB-003" } });
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Review skyline" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    expect(within(form).getByText("Choose a task table.")).toBeVisible();
    expect(onAuthor).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText("Task table in plans/moon.md for ORB-S01"), { target: { value: "30" } });
    fireEvent.change(within(form).getByLabelText("Priority"), { target: { value: "P1" } });
    fireEvent.change(within(form).getByLabelText("Status"), { target: { value: "Ready" } });
    fireEvent.change(within(form).getByLabelText("Dependencies"), { target: { value: "None" } });
    fireEvent.change(within(form).getByLabelText("Repository / owner"), { target: { value: "observatory-ui" } });
    fireEvent.change(within(form).getByLabelText("Required outcome"), { target: { value: "Review skyline" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(form).getByText("Document changed")).toBeVisible());
    expect(within(form).getByLabelText("Task ID")).toHaveValue("ORB-003");
    expect(onAuthor).toHaveBeenCalledExactlyOnceWith("plans/moon.md", {
      operation: "create.task", id: "ORB-003", storyId: "ORB-S01", title: "Review skyline", tableHeaderLine: 30,
      cells: { Priority: "P1", Status: "Ready", Dependencies: "None", "Repository / owner": "observatory-ui", "Required outcome": "Review skyline" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Refresh and retry" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onAuthor).toHaveBeenCalledTimes(2));
  });

  it("returns focus to the task trigger when linking the first task moves its story to a project", async () => {
    const first = story("ORB-S03", []);
    function Harness() {
      const [board, setBoard] = useState<Board>({ ...writable(), stories: [...writable().stories, first] });
      return <Stories {...props(board)} editable onRefresh={async () => true} onAuthor={async (_file, operation) => {
        if (operation.operation === "create.task") setBoard((current) => ({
          ...current,
          stories: current.stories.map((entry) => entry.id === first.id ? { ...entry, taskIds: [operation.id] } : entry),
          tasks: [...current.tasks, task(operation.id, { storyId: first.id })],
        }));
        return true;
      }} />;
    }
    render(<Harness />);
    const before = group("Story ORB-S03 from plans/moon.md line 10");
    toggle(before, true);
    fireEvent.click(within(before).getByRole("button", { name: "Add task to ORB-S03" }));
    const form = screen.getByRole("form", { name: "Create task for ORB-S03" });
    fireEvent.change(within(form).getByLabelText("Task ID"), { target: { value: "ORB-003" } });
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Map the sky" } });
    fireEvent.change(within(form).getByLabelText("Status"), { target: { value: "Ready" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(before).not.toBeInTheDocument());
    const after = group("Story ORB-S03 from plans/moon.md line 10");
    await waitFor(() => expect(within(after).getByRole("button", { name: "Add task to ORB-S03" })).toHaveFocus());
    expect(after).toHaveAttribute("open");
  });

  it("keeps a confirmed write distinct from a failed refresh and offers recovery", async () => {
    const onAuthor = vi.fn(async () => false), onRefresh = vi.fn(async () => true);
    render(<Stories {...props(writable())} editable onAuthor={onAuthor} onRefresh={onRefresh} />);
    openStory();
    fireEvent.click(screen.getByRole("button", { name: "Add subtask to ORB-001" }));
    const form = screen.getByRole("form", { name: "Create subtask for ORB-001" });
    fireEvent.change(within(form).getByLabelText("Subtask ID"), { target: { value: "ORB-001.2" } });
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Inspect the stars" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(form).getByText(/write succeeded, but the view could not refresh/i)).toBeVisible());
    expect(onAuthor).toHaveBeenCalledExactlyOnceWith("plans/moon.md", {
      operation: "create.subtask", taskId: "ORB-001", id: "ORB-001.2", title: "Inspect the stars",
    });
    expect(within(form).getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(within(form).getByRole("button", { name: "Refresh and retry" }));
    await waitFor(() => expect(form).not.toBeInTheDocument());
    expect(onRefresh).toHaveBeenCalledExactlyOnceWith();
  });

  it("toggles a parsed subtask and uses the guarded status callback", async () => {
    const onAuthor = vi.fn(async () => true), onSetStatus = vi.fn(async () => {});
    render(<Stories {...props(writable())} editable onAuthor={onAuthor} onRefresh={async () => true} onSetStatus={onSetStatus} />);
    openStory();
    fireEvent.click(screen.getByRole("checkbox", { name: /ORB-001\.1 Inspect the moon/ }));
    await waitFor(() => expect(onAuthor).toHaveBeenCalledExactlyOnceWith("plans/moon.md", {
      operation: "toggle.subtask", taskId: "ORB-001", id: "ORB-001.1",
    }));
    fireEvent.change(screen.getByLabelText("Status for ORB-001"), { target: { value: "Complete" } });
    await waitFor(() => expect(onSetStatus).toHaveBeenCalledWith(expect.objectContaining({ id: "ORB-001" }), "Complete"));
  });

  it("confirms before a status move drops its qualifier, while cancel leaves the row untouched", async () => {
    const source = writable();
    const board = { ...source, tasks: source.tasks.map((entry) => entry.id === "ORB-001"
      ? { ...entry, status: "Ready - awaiting telescope", statusQualifier: "awaiting telescope" } : entry) };
    const onSetStatus = vi.fn(async () => {});
    render(<Stories {...props(board)} editable onRefresh={async () => true} onSetStatus={onSetStatus} />);
    openStory();
    const select = screen.getByLabelText("Status for ORB-001");
    fireEvent.change(select, { target: { value: "Complete" } });
    const dialog = screen.getByRole("dialog", { name: "Move ORB-001 to Complete?" });
    expect(dialog).toHaveTextContent("awaiting telescope");
    expect(onSetStatus).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(select).toHaveValue("Ready");
    expect(onSetStatus).not.toHaveBeenCalled();
    fireEvent.change(select, { target: { value: "Complete" } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "Move ORB-001 to Complete?" }))
      .getByRole("button", { name: "Move and drop qualifier" }));
    await waitFor(() => expect(onSetStatus).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "ORB-001" }), "Complete"));
  });

  it("copies current task context after a status move and preserves a manually edited intent", async () => {
    const copied = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copied } });
    const original = writable();
    const { rerender } = render(<Stories {...props(original)} editable onSetStatus={async () => {}} />);
    openStory();
    const trigger = screen.getByRole("button", { name: "Draft with agent for ORB-001" });
    fireEvent.click(trigger);
    let panel = screen.getByRole("region", { name: "Agent draft intent for ORB-001" });
    expect((within(panel).getByLabelText("Intent for ORB-001") as HTMLTextAreaElement).value).toContain("Status: Ready");
    fireEvent.click(trigger);
    const moved = { ...original, tasks: original.tasks.map((entry) => entry.id === "ORB-001"
      ? { ...entry, status: "Complete", statusBase: "Complete" } : entry) };
    rerender(<Stories {...props(moved)} editable onSetStatus={async () => {}} />);
    fireEvent.click(trigger);
    panel = screen.getByRole("region", { name: "Agent draft intent for ORB-001" });
    expect((within(panel).getByLabelText("Intent for ORB-001") as HTMLTextAreaElement).value).toContain("Status: Complete");
    fireEvent.click(within(panel).getByRole("button", { name: "Copy intent for ORB-001" }));
    await waitFor(() => expect(copied).toHaveBeenCalledWith(expect.stringContaining("Status: Complete")));
    fireEvent.change(within(panel).getByLabelText("Intent for ORB-001"), { target: { value: "My edited plan" } });
    const changed = { ...moved, tasks: moved.tasks.map((entry) => entry.id === "ORB-001"
      ? { ...entry, status: "Blocked", statusBase: "Blocked" } : entry) };
    rerender(<Stories {...props(changed)} editable onSetStatus={async () => {}} />);
    expect(within(panel).getByLabelText("Intent for ORB-001")).toHaveValue("My edited plan");
    expect(within(panel).getByText(/Source context changed/)).toBeVisible();
  });

  it("keeps viewer mode free of enabled mutation controls and drafts only copy intent", async () => {
    const onAuthor = vi.fn(async () => true);
    render(<Stories {...props(writable())} onAuthor={onAuthor} />);
    openStory();
    expect(screen.queryByRole("button", { name: /^Add (story|task|subtask)/ })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /ORB-001\.1/ })).toBeDisabled();
    expect(screen.queryByLabelText("Status for ORB-001")).not.toBeInTheDocument();
    const copied = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copied } });
    fireEvent.click(screen.getByRole("button", { name: "Draft with agent for ORB-001.1" }));
    const panel = screen.getByRole("region", { name: "Agent draft intent for ORB-001.1" });
    fireEvent.change(within(panel).getByLabelText("Intent for ORB-001.1"), { target: { value: "Review the night sky" } });
    expect(copied).not.toHaveBeenCalled();
    fireEvent.click(within(panel).getByRole("button", { name: "Copy intent for ORB-001.1" }));
    await waitFor(() => expect(copied).toHaveBeenCalledExactlyOnceWith("Review the night sky"));
    expect(within(panel).getByRole("status")).toHaveTextContent(/Submit it to an external agent manually/);
    expect(onAuthor).not.toHaveBeenCalled();
  });
});

describe("Roadmap in the real App", () => {
  let originalUrl: string, originalStorage: string | null;
  beforeEach(() => {
    originalUrl = window.location.href; originalStorage = localStorage.getItem("projects-board.dark-mode");
    localStorage.setItem("projects-board.dark-mode", "false");
    vi.spyOn(api, "fetchSession").mockResolvedValue({ sourceRef: "fictional", sourceSha: "a".repeat(40), builtAt: "2026-08-20T12:00:00Z",
      capabilities: { history: false, liveEvents: false, localWrites: false } });
  });
  afterEach(() => {
    window.history.replaceState(null, "", originalUrl);
    if (originalStorage === null) localStorage.removeItem("projects-board.dark-mode"); else localStorage.setItem("projects-board.dark-mode", originalStorage);
  });
  function transport(board: Board | null = fixture()) {
    vi.spyOn(state, "useBoard").mockReturnValue({ board, sourceRef: "fictional", sourceSha: "a".repeat(40), tracking: null, git: null, loading: false, error: null, touched: [], pending: new Map(), undoable: null, writing: false,
      lastChanged: {}, live: "unsupported", behind: false, refreshedAt: null, checkedAt: null, reload: async () => true,
      setStatus: async () => {}, setPriority: async () => {}, moveRow: async () => {}, addNote: async () => {}, undo: async () => {}, clearTouched: () => {} });
  }
  it("keeps view=stories public links and opens and closes the real story drawer", async () => {
    window.history.replaceState(null, "", "/#view=stories"); transport(); render(<App />);
    expect(await screen.findByRole("radio", { name: "Roadmap" })).toBeChecked();
    expect(screen.queryByRole("radio", { name: "Stories" })).not.toBeInTheDocument();
    expect(screen.getByText("Roadmap grouped by project, epic, and story or enabler.")).toBeVisible();
    expect(group("Project Observatory")).toBeVisible(); expect(group("Epic plans/moon.md in orbit")).toBeVisible();
    const outcome = group("Story ORB-S01 from plans/moon.md line 10"); toggle(outcome, true);
    const action = within(outcome).getByRole("button", { name: /^Open story ORB-S01/ }); action.focus(); fireEvent.click(action);
    expect(await screen.findByRole("dialog")).toBeVisible(); expect(window.location.hash).toBe("#view=stories&story=ORB-S01");
    fireEvent.keyDown(document, { key: "Escape" }); await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(window.location.hash).toBe("#view=stories"); await waitFor(() => expect(action).toHaveFocus());
  });
  it.each([["", "Now"], ["now", "Now"], ["rollup", "Rollup"], ["kanban", "Board"], ["backlog", "Backlog"], ["graph", "Dependencies"]])
    ("retains the %s view identifier and %s selection", async (view, label) => {
      window.history.replaceState(null, "", `/${view ? `#view=${view}` : ""}`); transport(null); render(<App />);
      expect(await screen.findByRole("radio", { name: label })).toBeChecked();
      expect(screen.getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Now", "Roadmap", "Rollup", "Board", "Backlog", "Dependencies"]);
      fireEvent.click(screen.getByRole("radio", { name: "Roadmap" })); expect(window.location.hash).toBe("#view=stories");
      fireEvent.click(screen.getByRole("radio", { name: label })); expect(window.location.hash).toBe(view && view !== "now" ? `#view=${view}` : "");
    });
  it("preserves project, text, and row filters when opening the backlog", async () => {
    const filters = "project=orbit&q=ORB&priority=P1&status=Ready&readiness=startable&group=epic";
    window.history.replaceState(null, "", `/#view=stories&${filters}`);
    const board = fixture(); transport({ ...board, tasks: [...board.tasks, task("ORB-999")] }); render(<App />);
    await screen.findByRole("radio", { name: "Roadmap" });
    expect(group("Project Observatory")).toBeVisible(); expect(screen.queryByRole("group", { name: "Project Solar" })).not.toBeInTheDocument();
    expect(screen.getByText(/2 stories over 2 of 3 rows/)).toBeVisible(); fireEvent.click(screen.getByRole("button", { name: "Open backlog" }));
    const params = new URLSearchParams(window.location.hash.slice(1)); expect(params.get("view")).toBe("backlog");
    for (const [key, value] of new URLSearchParams(filters)) expect(params.get(key)).toBe(value);
    expect(screen.getByRole("radio", { name: "Backlog" })).toBeChecked();
    expect(screen.getByPlaceholderText(/Search ID/)).toHaveValue("ORB");
    expect(screen.getByRole("button", { name: /Observatory.*tasks/ })).toHaveAttribute("aria-current", "true");
    for (const id of ["ORB-001", "ORB-002", "ORB-999"]) expect(screen.getByRole("button", { name: id })).toBeVisible();
    expect(screen.queryByRole("button", { name: "SUN-001" })).not.toBeInTheDocument();
  });

  it.each(["now", "stories", "rollup"])("makes paused filters removable in %s without losing project scope", async (view) => {
    window.history.replaceState(null, "", `/#view=${view}&project=orbit&q=ORB&priority=P1&status=Ready`);
    transport(); render(<App />);
    const paused = await screen.findByRole("region", { name: "Paused task filters" });
    expect(paused).toHaveTextContent("Search: ORB");
    expect(paused).toHaveTextContent("Priority: P1");
    fireEvent.click(within(paused).getByRole("button", { name: "Remove search filter: ORB" }));
    let params = new URLSearchParams(window.location.hash.slice(1));
    expect(params.has("q")).toBe(false);
    expect(params.get("priority")).toBe("P1");
    fireEvent.click(within(paused).getByRole("button", { name: "Clear task filters" }));
    expect(screen.queryByRole("region", { name: "Paused task filters" })).not.toBeInTheDocument();
    params = new URLSearchParams(window.location.hash.slice(1));
    expect(params.get("project")).toBe("orbit");
    expect(params.has("priority")).toBe(false);
    expect(params.has("status")).toBe(false);
  });

  it("opens a new project without stale row filters or grouping", async () => {
    window.history.replaceState(null, "", "/#view=backlog&project=orbit&q=ORB&epic=plans%2Fmoon.md&priority=P1&status=Blocked&group=epic");
    transport(); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Solar.*tasks/ }));
    expect(window.location.hash).toBe("#view=backlog&project=sun");
    expect(screen.getByRole("button", { name: "SUN-001" })).toBeVisible();
    expect(screen.getByPlaceholderText(/Search ID/)).toHaveValue("");
  });

  it("finds a project in a large portfolio and keeps the selected scope visible after clearing search", async () => {
    const board = fixture();
    const projects = Array.from({ length: 80 }, (_, index) => ({ ...board.projects[0]!, id: `portfolio-${index}`, label: `Project ${index}` }));
    transport({ ...board, projects }); render(<App />);
    const search = await screen.findByRole("searchbox", { name: "Find project" });
    fireEvent.change(search, { target: { value: "portfolio-79" } });
    expect(screen.getByRole("status")).toHaveTextContent("1 of 80 projects");
    expect(screen.getByRole("button", { name: /Project 79.*tasks/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Project 78.*tasks/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Project 79.*tasks/ }));
    expect(window.location.hash).toBe("#project=portfolio-79");
    fireEvent.change(search, { target: { value: "no-such-project" } });
    expect(screen.getByText("No projects match “no-such-project”.")).toBeVisible();
    expect(screen.getByRole("button", { name: /All projects.*tasks/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Clear project search" }));
    expect(search).toHaveFocus();
    expect(search).toHaveValue("");
    expect(screen.getByRole("button", { name: /Project 79.*tasks/ })).toHaveAttribute("aria-current", "true");
  });

  it("does not add a history step when the active view shortcut is clicked again", async () => {
    window.history.replaceState(null, "", "/#view=backlog");
    transport(); render(<App />);
    const shortcut = await screen.findByRole("button", { name: "Tasks" });
    expect(shortcut).toHaveAttribute("aria-current", "page");
    const length = window.history.length;
    fireEvent.click(shortcut);
    expect(window.history.length).toBe(length);
    expect(window.location.hash).toBe("#view=backlog");
  });

  it("reports a stale task filter only when the active view applies it", async () => {
    window.history.replaceState(null, "", "/#view=stories&project=orbit&epic=deleted.md");
    transport(); render(<App />);
    const paused = await screen.findByRole("region", { name: "Paused task filters" });
    expect(paused).toHaveTextContent("Epic: deleted.md");
    expect(screen.queryByText("This link filters on something that no longer exists")).not.toBeInTheDocument();
    fireEvent.click(within(paused).getByRole("button", { name: "View filtered tasks" }));
    expect(screen.getByText("This link filters on something that no longer exists")).toBeVisible();
  });

  it.each(["now", "backlog", "kanban"])("offers task navigation in %s without nesting actions inside the task button", async (view) => {
    window.history.replaceState(null, "", `/#view=${view}&project=orbit`);
    transport(); const { container } = render(<App />);
    const trigger = await screen.findByRole("button", { name: "Actions for ORB-001" });
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "Actions for ORB-001" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent))
      .toEqual(["Open task details", "Show dependencies", "Find in backlog"]);
    expect(container.querySelector("button button")).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Find in backlog" }));
    expect(window.location.hash).toBe("#view=backlog&q=ORB-001&project=orbit");
    expect(screen.getByRole("button", { name: "ORB-001" })).toBeVisible();
  });
});
