import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_WORKFLOW, type WorkflowConfig } from "../shared/config.ts";
import { toBoardResponse } from "../server/board-response.ts";
import { buildBoard, revisionOf, type SourceDocument } from "../server/ledger/model.ts";
import * as readinessSource from "../server/ledger/qwen-readiness.ts";

const row = (id = "ORB-001", status = "Ready", dependencies = "None") =>
  `| ${id} | P1 | ${status} | ${dependencies} | orbit | Record the orbit. |`;
function source(rows: readonly string[], body = "", path = "plans/orbit.md", writable?: boolean): SourceDocument {
  const text = ["# Orbit", "", "| ID | Priority | Status | Dependencies | Repository | Required outcome |",
    "|---|---|---|---|---|---|", ...rows, "", body].join("\n");
  return { path, text, sha256: createHash("sha256").update(text).digest("hex"),
    ...(writable === undefined ? {} : { writable }) };
}
function story(id = "ORB-S01", members = "`ORB-001`", kind = "story") {
  return `### ${id} - Observe an orbit\n\n- **Kind:** ${kind}\n- **Outcome:** record the orbit\n- **So that:** observations agree\n- **Delivered by:** ${members}\n`;
}
function packet(id = "ORB-001", title = "Observe the orbit") {
  const labels = ["Objective", "Why", "Scope", "Starting point", "Decisions already made", "Decision authority",
    "Contract", "Change required", "Invariants", "Non-goals", "Acceptance criteria", "Verify", "Escalate, do not assume, if", "Handoff"];
  return [`### ${id} - ${title}`, "", "#### Qwen3-Coder-Next packet", "", "- **Readiness:**",
    "  - Packet status: READY", "  - Work kind: implementation",
    "  - Estimated changed LOC: production 250; tests 100; total 350",
    "  - File/symbol plan: orbit:src/orbit.ts | state: existing | symbols: observe | behavior: record the orbit | write: observe only | proof: orbit fixture",
    ...labels.map((label) => `- **${label}:** Bounded orbit evidence.`)].join("\n");
}
const build = (documents: readonly SourceDocument[], workflow: WorkflowConfig = DEFAULT_WORKFLOW) =>
  buildBoard(documents, new Set(["orbit"]), [], "2026-09-08T12:00:00.000Z", workflow);
const reviewWorkflow = { ...DEFAULT_WORKFLOW, statusOrder: [...DEFAULT_WORKFLOW.statusOrder, "Review"] };

describe("Qwen task subjects", () => {
  it.each([undefined, true, false])("projects actual document writability %s without changing packet structure", (writable) => {
    const board = build([source([row()], story() + packet(), undefined, writable)]);
    const task = board.tasks[0]!;
    expect(board.documents[0]?.writable).toBe(writable !== false);
    expect(task).toMatchObject({ writable: writable !== false, storyId: "ORB-S01",
      title: "Observe the orbit", qwen3CoderNextReady: true, packetMetadata: { workKind: "implementation", issues: [] } });
    expect(task.readiness).toBe(writable === false ? null : "startable");
    for (const cell of [task.statusCell, task.priorityCell, task.outcomeCell]) {
      if (writable === false) expect(cell).toBeNull(); else expect(cell).not.toBeNull();
    }
  });

  it.each(["story", "enabler"])("assigns one same-file %s despite repeated member tokens", (kind) => {
    const board = build([source([row()], story("ORB-S01", "`ORB-001`, `ORB-001`", kind))]);
    expect(board.tasks[0]?.storyId).toBe("ORB-S01");
    expect(board.issues.some((issue) => issue.kind === "story-member-shared")).toBe(false);
  });

  it.each(["Ready", "Blocked", "Review", "Unknown"])("reports unassigned nonterminal %s", (status) => {
    const board = build([source([row(undefined, status)])], reviewWorkflow);
    expect(board.tasks[0]?.storyId).toBeNull();
    expect(board.issues).toContainEqual(expect.objectContaining({ kind: "story-member-unassigned", taskId: "ORB-001" }));
  });

  it("never selects the first of two same-file parents", () => {
    for (const bodies of [[story(), story("ORB-S02")], [story("ORB-S02"), story()]]) {
      const board = build([source([row()], bodies.join("\n"))]);
      expect(board.tasks[0]?.storyId).toBeNull();
      expect(board.issues.filter((issue) => issue.kind === "story-member-shared")).toHaveLength(2);
    }
  });

  it.each([false, true])("retains foreign claims when local membership is %s", (localClaim) => {
    const documents = [source([row()], localClaim ? story() : ""), source([], story("EXT-S01"), "plans/other.md")];
    for (const ordered of [documents, [...documents].reverse()]) {
      const board = build(ordered);
      expect(board.tasks[0]?.storyId).toBeNull();
      expect(board.issues).toContainEqual(expect.objectContaining({ kind: "story-member-cross-file", taskId: "EXT-S01" }));
    }
  });

  it.each([false, true])("invalidates disjoint duplicate story identities when the second is incomplete: %s", (incomplete) => {
    const second = incomplete ? "### ORB-S01 - Incomplete\n" : story("ORB-S01", "`ORB-002`");
    for (const bodies of [[story(), second], [second, story()]]) {
      const board = build([source([row(), row("ORB-002")], bodies.join("\n"))]);
      expect(board.tasks.map((task) => task.storyId)).toEqual([null, null]);
      expect(board.issues.some((issue) => issue.kind === "story-member-shared")).toBe(true);
    }
  });

  it("invalidates duplicate raw story identities across files", () => {
    const documents = [source([row()], story()), source([row("ORB-002")], story("ORB-S01", "`ORB-002`"), "plans/other.md")];
    for (const ordered of [documents, [...documents].reverse()]) {
      expect(build(ordered).tasks.every((task) => task.storyId === null)).toBe(true);
    }
  });

  it("retains the same complete diagnostics when document order changes", () => {
    const documents = [
      source([row()], story() + story("ORB-S02")),
      source([row("ORB-002")], story("ORB-S01", "`ORB-002`") + story("EXT-S01"), "plans/other.md"),
    ];
    const forward = build(documents);
    const reversed = build([...documents].reverse());
    const diagnostics = (board: ReturnType<typeof build>) =>
      board.issues.map((issue) => JSON.stringify(issue)).sort();
    expect(diagnostics(reversed)).toEqual(diagnostics(forward));
    expect(forward.tasks.every((task) => task.storyId === null)).toBe(true);
    expect(forward.issues.filter((issue) => issue.kind === "story-member-cross-file")).toHaveLength(1);
    expect(forward.issues.filter((issue) => issue.kind === "story-member-shared")).toHaveLength(5);
  });

  it.each([false, true])("never borrows identity for duplicated ledger IDs across files: %s", (acrossFiles) => {
    const documents = acrossFiles
      ? [source([row()], story() + packet()), source([row()], packet(undefined, "Foreign title"), "plans/other.md")]
      : [source([row(), row()], story() + packet())];
    for (const task of build(documents).tasks) {
      expect(task).toMatchObject({ title: null, storyId: null, qwen3CoderNextReady: false });
      expect(task.packetMetadata.issues.join(" ")).toMatch(/ledger.*identity|ledger rows/i);
    }
  });

  it("rejects duplicate local details instead of choosing their title or packet", () => {
    const task = build([source([row()], packet() + "\n\n" + packet(undefined, "Second title"))]).tasks[0]!;
    expect(task).toMatchObject({ title: null, qwen3CoderNextReady: false });
    expect(task.packetMetadata.issues.join(" ")).toMatch(/multiple.*same-file/i);
  });

  it.each([false, true])("never substitutes foreign detail when local detail exists: %s", (local) => {
    const task = build([source([row()], local ? packet() : ""),
      source([], packet(undefined, "Foreign title"), "plans/other.md")]).tasks[0]!;
    expect(task.title).toBe(local ? "Observe the orbit" : null);
    expect(task.qwen3CoderNextReady).toBe(local);
    expect(task.packetMetadata.issues.length > 0).toBe(!local);
  });

  it.each(["Work kind: invalid", "Estimated changed LOC: production 250; tests 100; total 351"])
    ("keeps Packet READY separate from invalid metadata %s and missing membership", (invalid) => {
      const markdown = packet().replace(invalid.startsWith("Work") ? "Work kind: implementation" :
        "Estimated changed LOC: production 250; tests 100; total 350", invalid);
      const task = build([source([row()], markdown)]).tasks[0]!;
      expect(task).toMatchObject({ storyId: null, qwen3CoderNextReady: true, readiness: "startable" });
      expect(task.packetMetadata.issues.length).toBeGreaterThan(0);
      expect(task.executionReadiness).toBe("unassessed");
    });

  it("exempts unassigned terminal history without hiding invalid terminal claims", () => {
    const clean = build([source([row(undefined, "Complete")])]);
    expect(clean.issues.some((issue) => issue.kind === "story-member-unassigned")).toBe(false);
    const invalid = build([source([row(undefined, "Complete")]), source([], story(), "plans/other.md")]);
    expect(invalid.tasks[0]?.storyId).toBeNull();
    expect(invalid.issues.some((issue) => issue.kind === "story-member-cross-file")).toBe(true);
    expect(invalid.issues.some((issue) => issue.kind === "story-member-unassigned")).toBe(false);
  });

  it("uses configured closed states independently of dependency satisfaction", () => {
    const workflow = { ...DEFAULT_WORKFLOW, statusOrder: ["Ready", "Done", "Cancelled"], activeStatuses: ["Ready"],
      blockedStatuses: [], closedStatuses: ["Done", "Cancelled"], dependencySatisfiedStatuses: ["Done"] };
    const board = build([source([row(undefined, "Cancelled"), row("ORB-002", "Ready", "ORB-001"), row("ORB-003", "Complete")])], workflow);
    expect(board.tasks.map((task) => task.readiness)).toEqual([null, "waiting", "needs-gate-check"]);
    expect(board.issues.filter((issue) => issue.kind === "story-member-unassigned").map((issue) => issue.taskId))
      .toEqual(["ORB-002", "ORB-003"]);
  });

  it("preserves frozen source bytes, counts and separate planning and Board revisions", () => {
    const documents = Object.freeze([Object.freeze(source([row()], story() + packet()))]);
    const before = JSON.stringify(documents);
    const board = build(documents);
    expect(build(documents)).toEqual(board);
    expect(JSON.stringify(documents)).toBe(before);
    expect(board.planRevision).toBe(revisionOf(documents));
    expect(board.revision).toBe(readinessSource.boardRevision(board.planRevision, readinessSource.missingQwenReadinessSource()));
    expect(board.documents[0]?.taskCount).toBe(1);
    expect(board.tasks).toHaveLength(1);
    expect(board.projects.reduce((sum, project) => sum + project.primaryCount, 0)).toBe(1);
  });

  it("constructs packet subjects without invoking repository I/O", () => {
    const load = vi.spyOn(readinessSource, "loadQwenReadinessSource").mockImplementation(() => {
      throw new Error("Repository I/O is forbidden during subject construction");
    });
    try {
      const task = build([source([row()], story() + packet())]).tasks[0]!;
      expect(task.packetMetadata.issues).toEqual([]);
      expect(load).not.toHaveBeenCalled();
    } finally { load.mockRestore(); }
  });

  it("transports both new diagnostics with additive subject and assessment fields", () => {
    const board = build([source([row()]), source([], story("EXT-S01"), "plans/other.md")]);
    const response = toBoardResponse(board);
    expect(response.issues.map((issue) => issue.kind)).toEqual(expect.arrayContaining([
      "story-member-cross-file", "story-member-unassigned",
    ]));
    expect(response.tasks[0]).toEqual(board.tasks[0]);
    expect(response.tasks[0]?.executionReadiness).toBe("unassessed");
    expect(response.documents[0]?.writable).toBe(board.documents[0]?.writable);
  });
});
