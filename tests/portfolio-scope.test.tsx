// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function fixture(): Board {
  return { generatedAt: "2026-08-20T12:00:00Z", revision: "a".repeat(64), planRevision: "a".repeat(64), workflow: DEFAULT_WORKFLOW,
    qwenReadiness: { status: "missing", schemaVersion: null, auditBaseCommit: null, capturedAt: null, candidateCount: 0, manifestSha256: null, error: null },
    tasks: [
      task("ORB-001"),
      task("ORB-002", { readiness: "waiting" }),
      task("ORB-003", { readiness: "needs-gate-check", priority: "P2" }),
      task("SUN-001", { file: "plans/sun.md", epic: "Sun", project: "sun", projects: ["sun"], priority: "P2", status: "Blocked", statusBase: "Blocked", readiness: null }),
    ],
    stories: [],
    documents: ["plans/moon.md", "plans/sun.md"].map((path) => ({ path, title: "Fictional sky", writable: true, sha256: "a".repeat(64), taskCount: 2,
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

let originalUrl: string, originalStorage: string | null, fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  originalUrl = window.location.href; originalStorage = localStorage.getItem("projects-board.dark-mode");
  localStorage.setItem("projects-board.dark-mode", "false");
  vi.spyOn(api, "fetchSession").mockResolvedValue({ sourceRef: "fictional", sourceSha: "a".repeat(40), builtAt: "2026-08-20T12:00:00Z",
    capabilities: { history: false, liveEvents: false, localWrites: false } });
  vi.spyOn(state, "useBoard").mockReturnValue({ board: fixture(), git: null, loading: false, error: null, touched: [], pending: new Map(), undoable: null,
    writing: false, lastChanged: {}, live: "unsupported", behind: false, refreshedAt: null, checkedAt: null, reload: async () => true,
    ...writes, clearTouched: () => {} });
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in this test"));
});

afterEach(() => {
  for (const write of Object.values(writes)) expect(write).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
  cleanup(); vi.restoreAllMocks(); vi.clearAllMocks();
  window.history.replaceState(null, "", originalUrl);
  if (originalStorage === null) localStorage.removeItem("projects-board.dark-mode"); else localStorage.setItem("projects-board.dark-mode", originalStorage);
});

function open(hash: string) {
  window.history.replaceState(null, "", `/${hash}`);
  return render(<App />);
}
const params = () => new URLSearchParams(window.location.hash.slice(1));
const pausedRegion = () => screen.queryByRole("region", { name: "Paused task filters" });
const searchBox = () => screen.getByPlaceholderText(/Search ID/);
const VIEWS = [["now", "Now"], ["stories", "Roadmap"], ["rollup", "Rollup"], ["kanban", "Board"], ["backlog", "Backlog"], ["graph", "Dependencies"]] as const;

describe("project scope and held filters", () => {
  it.each(VIEWS)("resets every row filter and the grouping when the rail selects a project from %s", async (view) => {
    open(`#view=${view}&project=orbit&q=ORB&priority=P1&status=Ready&readiness=startable&group=epic`);
    fireEvent.click(await screen.findByRole("button", { name: /Solar.*tasks/ }));
    expect(window.location.hash).toBe(view === "now" ? "#project=sun" : `#view=${view}&project=sun`);
    expect(pausedRegion()).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Solar.*tasks/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("heading", { level: 2, name: "Solar" })).toBeVisible();
    fireEvent.click(screen.getByRole("radio", { name: "Backlog" }));
    expect(window.location.hash).toBe("#view=backlog&project=sun");
    expect(screen.getByRole("button", { name: "SUN-001" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "ORB-001" })).not.toBeInTheDocument();
    expect(searchBox()).toHaveValue("");
    expect(screen.queryByRole("button", { name: /^Remove .* filter/ })).not.toBeInTheDocument();
  });

  it("resets row filters when a project-row menu opens another project's board", async () => {
    open("#view=backlog&project=orbit&q=ORB&priority=P1");
    fireEvent.click(await screen.findByRole("button", { name: "Open Solar in a view" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Open board" }));
    expect(window.location.hash).toBe("#view=kanban&project=sun");
    expect(screen.getByRole("radio", { name: "Board" })).toBeChecked();
    expect(searchBox()).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Priority" })).toHaveValue("");
  });

  it("restores the previous scope and filters on browser Back after a project change", async () => {
    open("#view=backlog&project=orbit&q=ORB&priority=P1");
    const before = window.location.hash;
    fireEvent.click(await screen.findByRole("button", { name: /Solar.*tasks/ }));
    expect(window.location.hash).toBe("#view=backlog&project=sun");
    window.history.back();
    await waitFor(() => expect(window.location.hash).toBe(before));
    await waitFor(() => expect(searchBox()).toHaveValue("ORB"));
    expect(screen.getByRole("button", { name: /Observatory.*tasks/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "ORB-001" })).toBeVisible();
  });

  it("keeps row filters on a plain view switch and names them while paused", async () => {
    open("#view=backlog&project=orbit&q=ORB&priority=P1");
    fireEvent.click(await screen.findByRole("radio", { name: "Roadmap" }));
    expect(params().get("view")).toBe("stories");
    expect(params().get("project")).toBe("orbit");
    expect(params().get("q")).toBe("ORB");
    expect(params().get("priority")).toBe("P1");
    const paused = pausedRegion()!;
    expect(paused).toHaveTextContent("Search: ORB");
    expect(paused).toHaveTextContent("Priority: P1");
  });

  it.each(["kanban", "backlog", "graph"])("shows a held readiness filter in %s and clears it without losing project scope", async (view) => {
    open(`#view=${view}&project=orbit&readiness=waiting`);
    const chip = await screen.findByRole("button", { name: "Remove readiness filter: waiting" });
    expect(chip).toBeVisible();
    expect(chip).toHaveTextContent("Readiness: waiting");
    expect(screen.getByRole("switch", { name: "Startable now" })).toHaveAttribute("aria-checked", "false");
    fireEvent.click(chip);
    expect(params().has("readiness")).toBe(false);
    expect(params().get("project")).toBe("orbit");
    expect(params().get("view")).toBe(view);
    expect(screen.queryByRole("button", { name: /^Remove readiness filter/ })).not.toBeInTheDocument();
  });

  it("carries a paused readiness filter into Backlog where it stays visible", async () => {
    open("#view=now&readiness=needs-gate-check");
    const paused = await screen.findByRole("region", { name: "Paused task filters" });
    expect(paused).toHaveTextContent("Readiness: needs-gate-check");
    fireEvent.click(within(paused).getByRole("button", { name: "View filtered tasks" }));
    expect(window.location.hash).toBe("#view=backlog&readiness=needs-gate-check");
    expect(pausedRegion()).not.toBeInTheDocument();
    const chip = screen.getByRole("button", { name: "Remove readiness filter: needs-gate-check" });
    expect(chip).toBeVisible();
    expect(chip).toHaveTextContent("Readiness: needs-gate-check");
    expect(screen.getByRole("button", { name: "ORB-003" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "ORB-001" })).not.toBeInTheDocument();
  });

  it.each(["kanban", "backlog", "graph"])("shows startable readiness only through the switch in %s", async (view) => {
    open(`#view=${view}&project=orbit&readiness=startable`);
    expect(await screen.findByRole("switch", { name: "Startable now" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("button", { name: /^Remove readiness filter/ })).not.toBeInTheDocument();
  });

  it("renders hostile URL filter values as literal text", async () => {
    const hostile = "<img src=x onerror=alert(1)>";
    open(`#view=now&q=${encodeURIComponent(hostile)}`);
    const paused = await screen.findByRole("region", { name: "Paused task filters" });
    expect(within(paused).getByRole("button", { name: `Remove search filter: ${hostile}` })).toHaveTextContent(`Search: ${hostile}`);
    expect(document.querySelector("img")).toBeNull();
  });

  it("explains a stale project link instead of showing a silently empty board", async () => {
    open("#view=kanban&project=ghost");
    expect(await screen.findByText("This link filters on something that no longer exists")).toBeVisible();
  });
});

describe("project change from composed views and the rail menu", () => {
  const COMPOSED = ["now", "stories", "rollup"] as const;
  const MENU_ROUTES = [["Open roadmap", "stories", "Roadmap"], ["Open board", "kanban", "Board"], ["Open dependencies", "graph", "Dependencies"]] as const;
  const HELD = "group=epic&q=ORB&epic=plans%2Fmoon.md&repo=lab&priority=P1&status=Ready&readiness=waiting";
  const chooseSolar = (item: string) => {
    fireEvent.click(screen.getByRole("button", { name: "Open Solar in a view" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: item }));
  };

  it.each(COMPOSED.flatMap((view) => MENU_ROUTES.map(([item, target, radio]) => [view, item, target, radio] as const)))(
    "clears held row filters when the project-row menu in %s opens another project via %s", async (view, item, target, radio) => {
    open(`#view=${view}&project=orbit&${HELD}`);
    expect(await screen.findByRole("region", { name: "Paused task filters" })).toHaveTextContent("Readiness: waiting");
    chooseSolar(item);
    expect(window.location.hash).toBe(`#view=${target}&project=sun`);
    expect(pausedRegion()).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: radio })).toBeChecked();
    expect(screen.getByRole("heading", { level: 2, name: "Solar" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Solar.*tasks/ })).toHaveAttribute("aria-current", "true");
    expect(screen.queryByRole("button", { name: /^Remove .* filter/ })).not.toBeInTheDocument();
  });

  it.each(COMPOSED)("restores the paused filters on browser Back after a project change from %s", async (view) => {
    open(`#view=${view}&project=orbit&q=ORB&priority=P1`);
    const before = window.location.hash;
    expect(await screen.findByRole("region", { name: "Paused task filters" })).toHaveTextContent("Search: ORB");
    fireEvent.click(screen.getByRole("button", { name: /Solar.*tasks/ }));
    expect(pausedRegion()).not.toBeInTheDocument();
    window.history.back();
    await waitFor(() => expect(window.location.hash).toBe(before));
    await waitFor(() => expect(pausedRegion()).toHaveTextContent("Search: ORB"));
    expect(pausedRegion()).toHaveTextContent("Priority: P1");
    expect(screen.getByRole("button", { name: /Observatory.*tasks/ })).toHaveAttribute("aria-current", "true");
  });

  it("drops held row filters when a Rollup project card opens that project's board", async () => {
    open(`#view=rollup&${HELD}`);
    expect(await screen.findByRole("region", { name: "Paused task filters" })).toHaveTextContent("Search: ORB");
    fireEvent.click(within(screen.getByRole("main")).getByRole("button", { name: "Solar" }));
    expect(window.location.hash).toBe("#view=kanban&project=sun");
    expect(pausedRegion()).not.toBeInTheDocument();
    expect(searchBox()).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Group by" })).toHaveValue("none");
    expect(screen.getByRole("heading", { level: 2, name: "Solar" })).toBeVisible();
  });

  it("keeps project scope and drops other filters when Rollup opens the startable queue", async () => {
    open("#view=rollup&project=orbit&q=ORB&priority=P2&readiness=waiting");
    fireEvent.click(await screen.findByRole("button", { name: "View 1 startable now" }));
    expect(window.location.hash).toBe("#view=kanban&project=orbit&readiness=startable");
    expect(screen.getByRole("switch", { name: "Startable now" })).toHaveAttribute("aria-checked", "true");
    expect(searchBox()).toHaveValue("");
  });

  it("clears project scope and other filters when a Rollup epic card opens that ledger's board", async () => {
    open("#view=rollup&project=orbit&q=ORB&priority=P1");
    const card = await screen.findByRole("button", { name: "Fictional sky" });
    const disclosure = card.closest("details")!;
    fireEvent.click(disclosure.querySelector("summary")!);
    expect(disclosure).toHaveAttribute("open");
    fireEvent.click(card);
    expect(window.location.hash).toBe("#view=kanban&epic=plans%2Fmoon.md");
    expect(screen.getByRole("heading", { level: 2, name: "All projects" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Epic" })).toHaveValue("plans/moon.md");
    expect(searchBox()).toHaveValue("");
  });

  it.each(MENU_ROUTES)("restores the default grouping, filters and closed panels when the project-row menu chooses %s", async (item, target, radio) => {
    open(`#view=graph&project=orbit&focus=ORB-001&story=ORB-S01&${HELD}`);
    expect(await screen.findByRole("button", { name: "Remove readiness filter: waiting" })).toBeVisible();
    chooseSolar(item);
    expect(window.location.hash).toBe(`#view=${target}&project=sun`);
    expect(screen.getByRole("radio", { name: radio })).toBeChecked();
    expect(screen.getByRole("button", { name: /Solar.*tasks/ })).toHaveAttribute("aria-current", "true");
    expect(screen.queryByRole("button", { name: /^Remove .* filter/ })).not.toBeInTheDocument();
  });

  it.each(VIEWS)("returns to all projects with no row filters or grouping when the rail resets scope from %s", async (view) => {
    open(`#view=${view}&project=orbit&${HELD}`);
    fireEvent.click(await screen.findByRole("button", { name: /All projects.*tasks/ }));
    expect(window.location.hash).toBe(view === "now" ? "" : `#view=${view}`);
    expect(screen.getByRole("button", { name: /All projects.*tasks/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("heading", { level: 2, name: "All projects" })).toBeVisible();
    expect(pausedRegion()).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Remove .* filter/ })).not.toBeInTheDocument();
  });
});

describe("URL text in scope and filter chips", () => {
  const hostile = `<script>alert("x")</script><iframe src=x></iframe>&amp;'"`;
  const long = "z".repeat(2000);

  it("renders angle brackets, quotes, entities and long values as literal chip text", async () => {
    open(`#view=stories&q=${encodeURIComponent(hostile)}&epic=${encodeURIComponent(long)}&repo=${encodeURIComponent(hostile)}&priority=${encodeURIComponent("'\"")}&status=${encodeURIComponent("<x>")}`);
    const paused = await screen.findByRole("region", { name: "Paused task filters" });
    const chips = within(paused).getAllByRole("button", { name: /^Remove / });
    expect(chips.map((chip) => chip.textContent)).toEqual([`Search: ${hostile}`, `Epic: ${long}`, `Repository: ${hostile}`, "Priority: '\"", "Status: <x>"]);
    expect(chips.map((chip) => chip.getAttribute("aria-label"))).toEqual([`Remove search filter: ${hostile}`, `Remove epic filter: ${long}`, `Remove repository filter: ${hostile}`, "Remove priority filter: '\"", "Remove status filter: <x>"]);
    expect(paused.innerHTML).toContain(`&lt;script&gt;alert("x")&lt;/script&gt;&lt;iframe src=x&gt;&lt;/iframe&gt;&amp;amp;'"`);
    expect(document.querySelectorAll("script, iframe")).toHaveLength(0);
    fireEvent.click(within(paused).getByRole("button", { name: "View filtered tasks" }));
    expect(searchBox()).toHaveValue(hostile);
    expect(document.querySelectorAll("script, iframe")).toHaveLength(0);
  });

  it("renders hostile stale-link values as literal notice text", async () => {
    open(`#view=kanban&project=${encodeURIComponent(hostile)}&epic=${encodeURIComponent(long)}&repo=${encodeURIComponent(hostile)}`);
    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toContain(`No row matches project “${hostile}” or epic “${long}” or repository “${hostile}”, so the board below`);
    expect(notice.innerHTML).toContain("&lt;script&gt;");
    expect(document.querySelectorAll("script, iframe")).toHaveLength(0);
    fireEvent.click(within(notice).getByRole("button", { name: "Clear them" }));
    expect(window.location.hash).toBe("#view=kanban");
  });

  it("drops an unknown readiness value instead of showing it", async () => {
    open(`#view=now&readiness=${encodeURIComponent(hostile)}`);
    await screen.findByRole("heading", { level: 2, name: "All projects" });
    expect(pausedRegion()).not.toBeInTheDocument();
  });
});
