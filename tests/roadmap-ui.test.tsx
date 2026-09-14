// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    readiness: "startable", writable: true, storyId: null, qwen3CoderNextReady: false, executionReadiness: "unassessed",
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
    expect(outcome).not.toHaveAttribute("open"); expect(within(outcome).getByRole("button")).not.toBeVisible();
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
    vi.spyOn(state, "useBoard").mockReturnValue({ board, git: null, loading: false, error: null, touched: [], pending: new Map(), undoable: null, writing: false,
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
