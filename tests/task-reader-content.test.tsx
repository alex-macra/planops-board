// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toBoardResponse } from "../server/board-response.ts";
import { buildBoard } from "../server/ledger/model.ts";
import { extractDetailBlocks } from "../server/ledger/detail.ts";
import { taskPacketMetadata } from "../server/ledger/qwen-readiness.ts";
import * as api from "../src/api.ts";
import { TaskDrawer } from "../src/components/TaskDrawer.tsx";

const base = toBoardResponse(buildBoard([{ path: "plans/orbit.md", sha256: "a".repeat(64), text: [
  "# Orbit", "| ID | Priority | Status | Dependencies | Required outcome |", "|---|---|---|---|---|",
  "| ORB-001 | P1 | Ready | None | Record an orbit. |", "### ORB-S01 - Observe",
  "- **Outcome:** Record observations.", "- **So that:** Orbits agree.", "- **Delivered by:** `ORB-001`",
  "### ORB-001 - Local observation", "- **Scope:** Read the orbit.",
].join("\n") }], new Set(), [], "2026-08-20T12:00:00.000Z"));
const task = base.tasks[0]!, detail = base.details.find((item) => item.id === task.id)!;
const mode = { kind: "local", onSaveStatus: vi.fn(), onSavePriority: vi.fn(), onAddNote: vi.fn() } as const;
const props = { task, board: base, mode, onClose: vi.fn(), onSelectTask: vi.fn(), onOpenGraph: vi.fn(),
  sourceRef: "refs/heads/main", sourceSha: "a".repeat(40) };
const tab = (name: string) => screen.getByRole("tab", { name });
const select = (name: string) => fireEvent.click(tab(name));
const summary = () => within(screen.getByRole("region", { name: "Derived implementation summary" }));
const recorded = () => within(screen.getByRole("region", { name: "Recorded fields" }));
const metadata: api.Task["packetMetadata"] = { workKind: "implementation", estimatedChangedLoc: {
  production: { min: 0, max: 20 }, tests: { min: 300, max: 300 }, total: { min: 300, max: 320 },
}, sizeException: "Atomic observation", splitTaskIds: ["ORB-002"], issues: [], files: [
  { repository: "orbit", path: "src/orbit.ts", state: "existing", symbols: ["observe", "Orbit"],
    behavior: "Record observations", writeBoundary: "Observe only", proof: "Run fictional orbit checks" },
] };
function sourcePacket(label: string, items: readonly string[]) {
  const labels = ["Readiness", "Objective", "Why", "Scope", "Starting point", "Decisions already made", "Decision authority",
    "Contract", "Change required", "Invariants", "Non-goals", "Acceptance criteria", "Verify", "Escalate, do not assume, if", "Handoff"];
  return extractDetailBlocks(["### ORB-001 - Local observation", "#### Qwen3-Coder-Next packet",
    ...labels.flatMap((name) => [`- **${name}:**`, ...(name === label ? items.map((item) => `  - ${item}`) : ["  - Recorded source."])])], task.file)[0]!;
}
beforeEach(() => vi.spyOn(api, "fetchTaskHistory").mockResolvedValue({ file: task.file, taskId: task.id, entries: [], commitsScanned: 0 }));
afterEach(async () => { await act(async () => undefined); cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("task reader content", () => {
  it("shows complete current recorded plans instead of historical audited values", () => {
    const files = [...metadata.files, { ...metadata.files[0]!, state: "new" as const, behavior: "Second behavior" }];
    const current = { ...task, packetMetadata: { ...metadata, files }, qwen3CoderNextReady: false,
      workKind: "verification" as const, sizeException: "Historical exception", executionReadiness: "stale" as const,
      estimatedChangedLoc: { production: { min: 800, max: 800 }, tests: { min: 100, max: 100 }, total: { min: 900, max: 900 } } };
    const fields = ["Contract", "Contract", "Unknown field"].map((label, index) => ({ label, rawLabel: label,
      date: `2026-08-${10 + index}`, items: [index === 0 ? "Record observations" : `Source ${index}`] }));
    render(<TaskDrawer {...props} task={current} board={{ ...base, details: [{ ...detail, fields }] }} />); select("Implementation");
    expect(summary().getByText("implementation", { exact: true })).toBeVisible();
    for (const value of ["0-20", "300", "300-320", "Atomic observation", "ORB-002"]) expect(summary().getByText(value)).toBeVisible();
    expect(summary().queryByText("Historical exception")).not.toBeInTheDocument();
    expect(summary().queryByText("900")).not.toBeInTheDocument();
    const cards = summary().getAllByRole("article"); expect(cards).toHaveLength(2);
    files.forEach((file, index) => {
      for (const value of [file.repository, file.path, file.state, ...file.symbols, file.behavior, file.writeBoundary, file.proof]) {
        expect(within(cards[index]!).getByText(value, { exact: true })).toBeVisible();
      }
    });
    expect(summary().getAllByText("Record observations")).toHaveLength(1);
    expect(recorded().getAllByText("Record observations")).toHaveLength(1);
    expect(recorded().getAllByRole("heading").slice(1).map((node) => node.textContent)).toEqual(fields.map((field) => field.label + field.date));
    expect(recorded().getByText("Source 2")).toBeVisible();
    expect(summary().queryAllByRole("link")).toHaveLength(0); expect(summary().queryAllByRole("button")).toHaveLength(0);
  });

  it.each(["verification", "research-docs", "owner-action", "external-hardware"] as const)("keeps %s non-code with no invented LOC", (workKind) => {
    render(<TaskDrawer {...props} task={{ ...task, packetMetadata: { ...metadata, workKind, estimatedChangedLoc: null } }} />);
    select("Implementation"); expect(summary().getByText(workKind, { exact: true })).toBeVisible();
    expect(summary().getAllByText("Not applicable")).toHaveLength(3);
    expect(summary().queryByText("0")).not.toBeInTheDocument();
  });

  it("retains a recorded non-implementation estimate with explicit context", () => {
    render(<TaskDrawer {...props} task={{ ...task, packetMetadata: { ...metadata, workKind: "verification" } }} />);
    select("Implementation"); expect(summary().getByText("300-320")).toBeVisible();
    expect(summary().getByText(/Non-implementation work/)).toBeVisible();
  });

  it("shows the missing-source diagnostic without inventing estimates", () => {
    const empty = taskPacketMetadata(null);
    render(<TaskDrawer {...props} task={{ ...task, packetMetadata: empty }} board={{ ...base, details: [] }} />);
    select("Implementation"); expect(summary().getAllByText("Not recorded").length).toBeGreaterThanOrEqual(5);
    empty.issues.forEach((issue) => expect(summary().getByText(issue)).toBeVisible());
    expect(summary().queryAllByRole("article")).toHaveLength(0);
  });

  it.each(["Readiness", "Contract"])("keeps partial and malformed %s source in its canonical panel", (label) => {
    const items = ["Work kind: implementation", "Estimated changed LOC: many lines", "Size exception:", "Split plan: ORB-002",
      "File/symbol plan: orbit:src/orbit.ts | state: existing | symbols: observe | behavior: partial behavior | write: observe only | proof: fictional checks",
      "File/symbol plan: malformed neighbor"];
    const source = sourcePacket(label, items), parsed = taskPacketMetadata(source);
    expect(parsed.estimatedChangedLoc).toBeNull(); expect(parsed.splitTaskIds).toEqual(["RB-00"]); expect(parsed.files).toHaveLength(1);
    render(<TaskDrawer {...props} task={{ ...task, packetMetadata: parsed }} board={{ ...base, details: [source] }} />);
    select("Implementation"); expect(summary().getByText("partial behavior")).toBeVisible();
    expect(summary().getByText("RB-00")).toBeVisible(); expect(summary().getByText("Recorded empty value")).toBeVisible();
    expect(summary().getAllByRole("list", { name: "Packet diagnostics" })[0]!.textContent).toBe(parsed.issues.join(""));
    items.forEach((item) => expect(recorded().queryAllByText(item, { exact: true })).toHaveLength(label === "Contract" ? 1 : 0));
    select("Evidence"); items.forEach((item) => expect(screen.queryAllByText(item, { exact: true })).toHaveLength(label === "Readiness" ? 1 : 0));
    expect(screen.getByRole("heading", { name: "Handoff" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Derived implementation summary" })).not.toBeInTheDocument();
  });

  it("preserves every diagnostic split and hostile card string as inert escaped text", () => {
    const hostile = "<img src=x onerror=alert(1)> `ORB-002` https://example.invalid";
    const files = [{ repository: hostile, path: hostile, state: "existing" as const, symbols: [hostile, hostile],
      behavior: hostile, writeBoundary: hostile, proof: hostile }];
    render(<TaskDrawer {...props} task={{ ...task, packetMetadata: { ...metadata, files, sizeException: "",
      splitTaskIds: ["ORB-002", "", hostile, "ORB-002"], issues: ["Repeated diagnostic", "Repeated diagnostic"] } }} />);
    select("Implementation"); const region = screen.getByRole("region", { name: "Derived implementation summary" });
    expect(summary().getAllByText(hostile)).toHaveLength(8);
    expect(summary().getAllByText("Repeated diagnostic")).toHaveLength(2);
    expect(within(summary().getByRole("list", { name: "Parsed split values" })).getAllByRole("listitem").map((node) => node.textContent))
      .toEqual(["ORB-002", "Recorded empty value", hostile, "ORB-002"]);
    expect(region.querySelectorAll("a, button, img, script")).toHaveLength(0);
  });

  it("preserves multiline strings and fence delimiters exactly without nested paragraph blocks or task links", () => {
    const blocks = ["plain\n`ORB-002`", "```ts\n  `ORB-002`\n```", "~~~text\n<video>\n~~~", "  ```text\n    indented\n  ```"];
    const fields = [{ label: "Contract", rawLabel: "Contract", date: null, items: [blocks[0]!] }];
    render(<TaskDrawer {...props} board={{ ...base, details: [{ ...detail, fields, prose: [...blocks.slice(1), "See `ORB-002` next."] }] }} />);
    select("Implementation"); const excerpts = screen.getAllByRole("region", { name: "Code excerpt" });
    expect(excerpts.map((node) => node.textContent)).toEqual(blocks);
    excerpts.forEach((node) => { expect(node).toHaveAttribute("tabindex", "0"); expect(node.closest("p")).toBeNull();
      expect(within(node).queryAllByRole("button")).toHaveLength(0); });
    fireEvent.click(screen.getByRole("button", { name: "ORB-002" })); expect(props.onSelectTask).toHaveBeenCalledWith("ORB-002");
  });

  it("keeps width, focused tab and mounted activity across metadata-only updates", async () => {
    const { rerender } = render(<TaskDrawer {...props} />); select("Evidence");
    await screen.findByText("No commit has changed this row's status.");
    fireEvent.change(screen.getByPlaceholderText("Add a note to the Markdown ledger"), { target: { value: "Preserved draft" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Reader width" }), { target: { value: "75" } });
    select("Implementation"); tab("Implementation").focus();
    rerender(<TaskDrawer {...props} task={{ ...task, packetMetadata: metadata }} />);
    expect(tab("Implementation")).toHaveFocus(); expect(tab("Implementation")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("combobox", { name: "Reader width" })).toHaveValue("75"); expect(summary().getByText("300-320")).toBeVisible();
    select("Evidence"); expect(screen.getByPlaceholderText("Add a note to the Markdown ledger")).toHaveValue("Preserved draft");
    expect(screen.getByText("No commit has changed this row's status.")).toBeVisible(); expect(api.fetchTaskHistory).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("region", { name: "Derived implementation summary" })).not.toBeInTheDocument();
  });

  it.each(["blocked", "unassessed"] as const)("retains current metadata when execution is %s", (executionReadiness) => {
    render(<TaskDrawer {...props} task={{ ...task, packetMetadata: metadata, executionReadiness, qwen3CoderNextReady: false }} />);
    select("Implementation"); expect(summary().getByText("Record observations")).toBeVisible();
    expect(summary().getByText(/not an audit or a readiness decision/)).toBeVisible();
  });

  it("preserves identical source items and dated repeated fields without deduplication", () => {
    const fields = ["2026-08-10", "2026-08-11"].map((date) => ({ label: "Contract", rawLabel: "Contract", date,
      items: ["Record observations", "Record observations", "Last item"] }));
    render(<TaskDrawer {...props} task={{ ...task, packetMetadata: metadata }} board={{ ...base, details: [{ ...detail, fields }] }} />);
    select("Implementation"); expect(recorded().getAllByText("Record observations")).toHaveLength(4);
    expect(recorded().getAllByRole("listitem").map((node) => node.textContent)).toEqual(fields.flatMap((field) => field.items));
    expect(summary().getAllByText("Record observations")).toHaveLength(1);
    fields.forEach((field) => expect(recorded().getByText(field.date)).toBeVisible());
  });

  it("does not repair recorded ranges or drop zero bounds during a live metadata update", () => {
    const { rerender } = render(<TaskDrawer {...props} task={{ ...task, packetMetadata: metadata }} />); select("Implementation");
    const zero = { min: 0, max: 0 };
    rerender(<TaskDrawer {...props} task={{ ...task, packetMetadata: { ...metadata, estimatedChangedLoc: { production: zero, tests: zero, total: zero } } }} />);
    expect(summary().getAllByText("0")).toHaveLength(3); expect(summary().queryByText("300-320")).not.toBeInTheDocument();
    expect(summary().getByText("Record observations")).toBeVisible();
  });

  it("displays malformed work kind as a diagnostic while keeping its source in Evidence", () => {
    const source = sourcePacket("Readiness", ["Work kind: unknown-kind"]), parsed = taskPacketMetadata(source);
    expect(parsed.workKind).toBeNull(); expect(parsed.issues.length).toBeGreaterThan(0);
    render(<TaskDrawer {...props} task={{ ...task, packetMetadata: parsed }} board={{ ...base, details: [source] }} />);
    select("Implementation"); expect(summary().getAllByText("Not recorded").length).toBeGreaterThanOrEqual(5);
    parsed.issues.forEach((issue) => expect(summary().getByText(issue)).toBeVisible());
    expect(recorded().queryByText("Work kind: unknown-kind")).not.toBeInTheDocument();
    select("Evidence"); expect(screen.getByText("Work kind: unknown-kind")).toBeVisible();
  });

  it("removes obsolete derived cards without removing the canonical recorded fields", () => {
    const fields = [{ label: "Contract", rawLabel: "Contract", date: null, items: ["Retained source"] }];
    const board = { ...base, details: [{ ...detail, fields }] };
    const { rerender } = render(<TaskDrawer {...props} board={board} task={{ ...task, packetMetadata: metadata }} />);
    select("Implementation"); expect(summary().getAllByRole("article")).toHaveLength(1);
    rerender(<TaskDrawer {...props} board={board} task={{ ...task, packetMetadata: taskPacketMetadata(null) }} />);
    expect(summary().queryAllByRole("article")).toHaveLength(0); expect(summary().queryByText("Record observations")).not.toBeInTheDocument();
    expect(recorded().getAllByText("Retained source")).toHaveLength(1);
    expect(tab("Implementation")).toHaveAttribute("aria-selected", "true");
  });

  it("partitions repeated fields and dates once while retaining notes and unknown prose", async () => {
    const groups = { Overview: ["Objective", "Why", "Scope", "Scope", "Acceptance criteria", "Acceptance criteria"],
      Implementation: ["Unknown field"], Evidence: ["Readiness", "Verify", "Handoff", "Evidence", "Evidence", "Note"] };
    const fields = Object.values(groups).flat().map((label, index) => ({ label, rawLabel: label,
      date: `2026-08-${String(index + 1).padStart(2, "0")}`, items: [`Recorded item ${index}`] }));
    const board = { ...base, details: [{ ...detail, fields, prose: ["Unlabelled observation.", "```text\nconst observation = 1;\n```"] }] };
    render(<TaskDrawer {...props} board={board} />);
    expect(tab("Overview")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Record an orbit.")).toBeVisible();
    expect(screen.getByText(/ORB-S01/)).toBeVisible();
    for (const [name, labels] of Object.entries(groups)) {
      select(name);
      const panel = within(screen.getByRole("tabpanel"));
      expect(panel.getAllByText(/^Recorded item /).map((node) => node.textContent)).toEqual(
        fields.filter((field) => labels.includes(field.label)).map((field) => field.items[0]));
      for (const field of fields) {
        expect(panel.queryAllByText(field.items[0]!, { exact: true })).toHaveLength(labels.includes(field.label) ? 1 : 0);
        if (labels.includes(field.label)) expect(panel.getByText(field.date)).toBeVisible();
      }
    }
    select("Implementation"); expect(screen.getByText("Unlabelled observation.")).toBeVisible();
    expect(screen.getByRole("region", { name: "Code excerpt" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("region", { name: "Code excerpt" })).toHaveTextContent("const observation = 1;");
    expect(screen.queryByPlaceholderText("Add a note to the Markdown ledger")).not.toBeInTheDocument();
    expect(mode.onAddNote).not.toHaveBeenCalled();
  });

  it.each(["duplicate task", "duplicate detail", "foreign only", "local and foreign"])("refuses note controls for %s ownership", (kind) => {
    const foreign = { ...detail, file: "plans/other.md", title: "Foreign observation" };
    const board = { ...base, tasks: kind === "duplicate task" ? [task, { ...task, line: task.line + 1 }] : [task],
      details: kind === "duplicate detail" ? [detail, { ...detail, headingLine: detail.headingLine + 1 }]
        : kind === "foreign only" ? [foreign] : kind === "local and foreign" ? [detail, foreign] : [detail] };
    render(<TaskDrawer {...props} board={board} />); select("Evidence");
    expect(screen.queryByPlaceholderText("Add a note to the Markdown ledger")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Short title for the work item")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add note" })).not.toBeInTheDocument();
    expect(screen.getByText(/ownership|ambiguous/i)).toBeVisible();
    expect(screen.queryByRole("dialog", { name: /Foreign observation/ })).not.toBeInTheDocument();
    expect(mode.onAddNote).not.toHaveBeenCalled();
  });

  it.each([false, true])("retains real activity drafts and history when existing detail is %s", async (existing) => {
    const board = { ...base, details: existing ? [detail] : [] };
    render(<TaskDrawer {...props} board={board} />);
    expect(screen.getAllByText("Not recorded").length).toBeGreaterThanOrEqual(existing ? 2 : 3);
    select("Evidence"); await screen.findByText("No commit has changed this row's status.");
    const input = screen.getByPlaceholderText("Add a note to the Markdown ledger");
    fireEvent.change(input, { target: { value: "Keep this draft." } });
    if (!existing) fireEvent.change(screen.getByPlaceholderText("Short title for the work item"), { target: { value: "Named observation" } });
    else expect(screen.queryByPlaceholderText("Short title for the work item")).not.toBeInTheDocument();
    select("Overview"); expect(screen.queryByPlaceholderText("Add a note to the Markdown ledger")).not.toBeInTheDocument();
    select("Evidence"); expect(screen.getByPlaceholderText("Add a note to the Markdown ledger")).toHaveValue("Keep this draft.");
    if (!existing) expect(screen.getByPlaceholderText("Short title for the work item")).toHaveValue("Named observation");
    expect(api.fetchTaskHistory).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add note" })); });
    expect(mode.onAddNote).toHaveBeenCalledExactlyOnceWith(task, "Keep this draft.", existing ? undefined : "Named observation");
  });

  it("retains activity failure and a busy submission across tab switches", async () => {
    let reject: (reason: Error) => void = () => undefined;
    mode.onAddNote.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    const { rerender } = render(<TaskDrawer {...props} />); select("Evidence");
    fireEvent.change(screen.getByPlaceholderText("Add a note to the Markdown ledger"), { target: { value: "Retry later." } });
    fireEvent.click(screen.getByRole("button", { name: "Add note" })); select("Overview"); select("Evidence");
    rerender(<TaskDrawer {...props} task={{ ...task, packetMetadata: metadata }} />);
    expect(screen.getByPlaceholderText("Add a note to the Markdown ledger")).toBeDisabled();
    await act(async () => { reject(new Error("Observation failed.")); });
    screen.getByPlaceholderText("Add a note to the Markdown ledger").focus();
    rerender(<TaskDrawer {...props} task={{ ...task, packetMetadata: { ...metadata, issues: ["New diagnostic"] } }} />);
    expect(screen.getByPlaceholderText("Add a note to the Markdown ledger")).toHaveFocus();
    select("Overview"); select("Evidence");
    expect(screen.getByText(/Observation failed/)).toBeVisible();
    expect(screen.getByPlaceholderText("Add a note to the Markdown ledger")).toHaveValue("Retry later.");
  });

  it("moves tab focus manually without mounting inactive controls", () => {
    render(<TaskDrawer {...props} />); tab("Overview").focus();
    for (const [key, name] of [["ArrowRight", "Implementation"], ["End", "Evidence"], ["ArrowRight", "Overview"], ["ArrowLeft", "Evidence"], ["Home", "Overview"]]) {
      fireEvent.keyDown(document.activeElement!, { key }); expect(tab(name!)).toHaveFocus();
      expect(screen.getAllByRole("tab").filter((node) => node.tabIndex === 0)).toEqual([tab(name!)]);
      expect(tab("Overview")).toHaveAttribute("aria-selected", "true");
    }
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Open full dependency graph" })).not.toBeInTheDocument();
    select("Dependencies"); fireEvent.click(screen.getByRole("button", { name: "Open full dependency graph" }));
    expect(props.onOpenGraph).toHaveBeenCalledWith(task.id);
    expect(screen.queryByRole("button", { name: "Save status" })).not.toBeInTheDocument();
  });

  it.each(["resolve", "reject"])("resets equal IDs in different files while retaining width after obsolete copies %s", async (outcome) => {
    let settle: () => void = () => undefined;
    vi.stubGlobal("navigator", { clipboard: { writeText: () => new Promise<void>((done, fail) => {
      settle = outcome === "resolve" ? done : () => fail(new Error("Clipboard rejected."));
    }) } });
    mode.onSaveStatus.mockRejectedValueOnce(new Error("Previous task failure."));
    const other = { ...task, file: "plans/other.md", status: "Ready - elsewhere", statusQualifier: "elsewhere" };
    const board = { ...base, tasks: [task, other], details: [detail, { ...detail, file: other.file }] };
    const { rerender } = render(<TaskDrawer {...props} board={board} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Reader width" }), { target: { value: "75" } });
    fireEvent.change(screen.getByLabelText("Qualifier (optional)"), { target: { value: "Unsaved qualifier" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save status" })); });
    expect(screen.getByText(/Previous task failure/)).toBeVisible();
    select("Evidence"); fireEvent.click(screen.getByRole("button", { name: "Copy task link" }));
    const body = screen.getByRole("tabpanel").closest(".task-reader-body")!; body.scrollTop = 200;
    rerender(<TaskDrawer {...props} board={board} task={other} />);
    expect(body.scrollTop).toBe(0);
    expect(tab("Overview")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Qualifier (optional)")).toHaveValue("elsewhere");
    expect(screen.queryByText(/Previous task failure/)).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Reader width" })).toHaveValue("75");
    rerender(<TaskDrawer {...props} board={board} />); select("Evidence");
    await act(async () => { settle(); }); expect(screen.queryByText("Task link copied.")).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be copied automatically/)).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Task link" })).not.toBeInTheDocument();
  });

  it("ignores an obsolete save failure without clearing the next task's busy state", async () => {
    let reject: (reason: Error) => void = () => undefined, resolve: () => void = () => undefined;
    mode.onSaveStatus.mockImplementationOnce(() => new Promise<void>((_done, fail) => { reject = fail; }))
      .mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    const { rerender } = render(<TaskDrawer {...props} />);
    fireEvent.change(screen.getByLabelText("Qualifier (optional)"), { target: { value: "First edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save status" }));
    rerender(<TaskDrawer {...props} task={{ ...task, id: "ORB-002" }} />);
    fireEvent.change(screen.getByLabelText("Qualifier (optional)"), { target: { value: "Second edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save status" }));
    await act(async () => { reject(new Error("Obsolete failure")); });
    expect(screen.queryByText("Obsolete failure")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save status" })).toBeDisabled();
    await act(async () => { resolve(); });
    expect(screen.getByRole("button", { name: "Save status" })).toBeEnabled();
  });
});
