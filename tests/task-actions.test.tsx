// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { DEFAULT_WORKFLOW } from "../shared/config.ts";
import * as api from "../src/api.ts";
import * as state from "../src/state.ts";
import type { Board, Task } from "../src/api.ts";
import { App } from "../src/App.tsx";

function task(id: string, partial: Partial<Task> = {}): Task {
  return { id, file: "plans/moon.md", epic: "Moon", section: null, title: id, line: 1, status: "Ready", statusBase: "Ready",
    statusQualifier: "", statusValid: true, priority: "P1", owners: [], repositories: [], project: "orbit", projects: ["orbit"],
    dependencies: [], dependencyResidue: [], outcome: "Observe", raw: {}, statusCell: null, priorityCell: null, outcomeCell: null,
    readiness: "startable", writable: true, storyId: null, qwen3CoderNextReady: false, executionReadiness: "unassessed",
    packetMetadata: { workKind: null, estimatedChangedLoc: null, sizeException: null, splitTaskIds: [], files: [], issues: [] },
    workKind: null, estimatedChangedLoc: null, sizeException: null, readinessCheckedAt: null, executionBlockers: [], ...partial };
}

function fixture(tasks: readonly Task[] = [task("ORB-001"), task("ORB-002"), task("SUN-001", { project: "sun", projects: ["sun"] })]): Board {
  return { generatedAt: "2026-08-20T12:00:00Z", revision: "a".repeat(64), planRevision: "a".repeat(64), workflow: DEFAULT_WORKFLOW,
    qwenReadiness: { status: "missing", schemaVersion: null, auditBaseCommit: null, capturedAt: null, candidateCount: 0, manifestSha256: null, error: null },
    tasks: [...tasks], stories: [],
    documents: ["plans/moon.md"].map((path) => ({ path, title: "Fictional sky", writable: true, sha256: "a".repeat(64), taskCount: tasks.length,
      vocabulary: { bases: DEFAULT_WORKFLOW.statusOrder, source: "configured" } })),
    projects: ["orbit", "sun"].map((id) => ({ id, label: id === "orbit" ? "Observatory" : "Solar", scope: "product", primaryCount: 2, taskCount: 2, parked: null })),
    details: [], findings: [], issues: [], statusBases: DEFAULT_WORKFLOW.statusOrder };
}

const writes = {
  setStatus: vi.fn(async () => {}),
  setPriority: vi.fn(async () => {}),
  moveRow: vi.fn(async () => {}),
  addNote: vi.fn(async () => {}),
  undo: vi.fn(async () => {}),
};

let originalUrl: string, originalStorage: string | null, fetchSpy: MockInstance<typeof fetch>;

function transport(board: Board = fixture(), localWrites = false) {
  vi.spyOn(api, "fetchSession").mockResolvedValue({ sourceRef: "fictional", sourceSha: "a".repeat(40), builtAt: "2026-08-20T12:00:00Z",
    capabilities: { history: false, liveEvents: false, localWrites } });
  vi.spyOn(state, "useBoard").mockReturnValue({ board, git: null, loading: false, error: null, touched: [], pending: new Map(), undoable: null,
    writing: false, lastChanged: {}, live: "unsupported", behind: false, refreshedAt: null, checkedAt: null, reload: async () => true,
    ...writes, clearTouched: () => {} });
}

beforeEach(() => {
  originalUrl = window.location.href; originalStorage = localStorage.getItem("projects-board.dark-mode");
  localStorage.setItem("projects-board.dark-mode", "false");
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in this test"));
});

afterEach(() => {
  const writeCalls = Object.fromEntries(Object.entries(writes).map(([name, write]) => [name, write.mock.calls.length]));
  const mutating = fetchSpy.mock.calls.filter(([, init]) => (init?.method ?? "GET").toUpperCase() !== "GET");
  cleanup(); vi.restoreAllMocks(); vi.clearAllMocks();
  window.history.replaceState(null, "", originalUrl);
  if (originalStorage === null) localStorage.removeItem("projects-board.dark-mode"); else localStorage.setItem("projects-board.dark-mode", originalStorage);
  expect(writeCalls).toEqual(Object.fromEntries(Object.keys(writes).map((name) => [name, 0])));
  expect(mutating).toEqual([]);
});

function open(hash: string, board?: Board, localWrites = false) {
  window.history.replaceState(null, "", `/${hash}`);
  transport(board, localWrites);
  return render(<App />);
}
const params = () => new URLSearchParams(window.location.hash.slice(1));
async function openMenu(id: string) {
  const trigger = await screen.findByRole("button", { name: `Actions for ${id}` });
  fireEvent.click(trigger);
  return { trigger, menu: screen.getByRole("menu", { name: `Actions for ${id}` }) };
}
const labels = (menu: HTMLElement) => within(menu).getAllByRole("menuitem").map((item) => item.textContent);

describe.each(["now", "backlog", "kanban"])("task actions in %s", (view) => {
  it("opens the reader for the task and keeps the view and project", async () => {
    open(`#view=${view}&project=orbit`);
    const { menu } = await openMenu("ORB-001");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Open task details" }));
    expect(params().get("task")).toBe("ORB-001");
    expect(params().get("project")).toBe("orbit");
    expect(params().get("view")).toBe(view === "now" ? null : view);
    expect(await screen.findByRole("dialog", { name: /ORB-001/ })).toBeVisible();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("shows dependencies in the graph focused on the task", async () => {
    open(`#view=${view}&project=orbit`);
    const { menu } = await openMenu("ORB-001");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Show dependencies" }));
    expect(window.location.hash).toBe("#view=graph&focus=ORB-001");
    expect(screen.getByRole("radio", { name: "Dependencies" })).toBeChecked();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("moves focus with the keyboard and returns it to the trigger on Escape", async () => {
    open(`#view=${view}&project=orbit`);
    const trigger = await screen.findByRole("button", { name: "Actions for ORB-001" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = screen.getByRole("menu", { name: "Actions for ORB-001" });
    const items = within(menu).getAllByRole("menuitem");
    await waitFor(() => expect(items[0]).toHaveFocus());
    expect(items[0]).toHaveTextContent("Open task details");
    fireEvent.keyDown(items[0]!, { key: "End" });
    expect(items.at(-1)).toHaveFocus();
    expect(items.at(-1)).toHaveTextContent("Find in backlog");
    fireEvent.keyDown(items.at(-1)!, { key: "Home" });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0]!, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});

describe("board status moves in the task menu", () => {
  const cell = { file: "plans/moon.md", line: 1, column: 3 };
  const board = () => fixture([task("ORB-001", { statusCell: cell }), task("ORB-002")]);

  it("offers no status moves when local writes are off, even for a writable status cell", async () => {
    open("#view=kanban&project=orbit", board(), false);
    const { trigger, menu } = await openMenu("ORB-001");
    expect(labels(menu)).toEqual(["Open task details", "Show dependencies", "Find in backlog"]);
    expect(within(menu).queryByRole("group", { name: "Move to" })).not.toBeInTheDocument();
    for (const base of DEFAULT_WORKFLOW.statusOrder) expect(within(menu).queryByRole("menuitem", { name: base })).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("lists every status base with the current one disabled when local writes are on", async () => {
    open("#view=kanban&project=orbit", board(), true);
    const { trigger, menu } = await openMenu("ORB-001");
    const moves = within(menu).getByRole("group", { name: "Move to" });
    expect(within(moves).getAllByRole("menuitem").map((item) => [item.textContent, (item as HTMLButtonElement).disabled]))
      .toEqual(DEFAULT_WORKFLOW.statusOrder.map((base) => [base, base === "Ready"]));
    fireEvent.keyDown(within(menu).getAllByRole("menuitem")[0]!, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(writes.setStatus).not.toHaveBeenCalled();
  });

  it("skips the disabled current status when End moves focus to the last item", async () => {
    open("#view=kanban&project=orbit", fixture([task("ORB-001", { statusCell: cell, status: "Complete", statusBase: "Complete" })]), true);
    const { menu } = await openMenu("ORB-001");
    const items = within(menu).getAllByRole("menuitem") as HTMLButtonElement[];
    expect(items.at(-1)).toHaveTextContent("Complete");
    expect(items.at(-1)).toBeDisabled();
    await waitFor(() => expect(items[0]).toHaveFocus());
    fireEvent.keyDown(items[0]!, { key: "End" });
    expect(items.at(-2)).toHaveTextContent("Blocked");
    expect(items.at(-2)).toHaveFocus();
    fireEvent.keyDown(items.at(-2)!, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("keeps status moves out of the menu for a task without a status cell", async () => {
    open("#view=kanban&project=orbit", board(), true);
    const { menu } = await openMenu("ORB-002");
    expect(within(menu).queryByRole("group", { name: "Move to" })).not.toBeInTheDocument();
  });
});

describe("find in backlog scope", () => {
  const board = () => fixture([task("ORB-001"), task("ORB-009", { title: "First" }), task("ORB-009", { title: "Second", line: 2 })]);

  it("keeps the project scope for a unique in-scope task", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    open("#view=backlog&project=orbit", board());
    const { menu } = await openMenu("ORB-001");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Find in backlog" }));
    expect(window.location.hash).toBe("#view=backlog&q=ORB-001&project=orbit");
  });

  it("drops the project scope for a duplicate ID so every occurrence stays findable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    open("#view=backlog&project=orbit", board());
    const triggers = await screen.findAllByRole("button", { name: "Actions for ORB-009" });
    expect(triggers).toHaveLength(2);
    fireEvent.click(triggers[0]!);
    const menu = screen.getByRole("menu", { name: "Actions for ORB-009" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Find in backlog" }));
    expect(window.location.hash).toBe("#view=backlog&q=ORB-009");
    expect(params().has("project")).toBe(false);
    expect(screen.getByPlaceholderText(/Search ID/)).toHaveValue("ORB-009");
    expect(screen.getByRole("button", { name: /All projects.*tasks/ })).toHaveAttribute("aria-current", "true");
  });
});
