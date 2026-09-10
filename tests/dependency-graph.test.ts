import { describe, expect, it } from "vitest";

import { DEFAULT_WORKFLOW } from "../shared/config.ts";
import type { Dependency, Task, Workflow } from "../shared/contracts.ts";
import { buildDependencyGraph } from "../src/dependency-graph.ts";

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const workflow: Workflow = freeze(structuredClone(DEFAULT_WORKFLOW));
const dependency = (id: string, changes: Partial<Dependency> = {}): Dependency =>
  ({ id, raw: id, gate: null, resolved: true, ambiguous: false, duplicate: false, ...changes });

function task(id: string, dependencies: readonly string[] = [], changes: Partial<Task> = {}): Task {
  return freeze({
    id, file: "plans/fictional.md", writable: false, storyId: null, epic: "Fictional graph",
    section: null, title: id, line: 1, status: "Ready", statusBase: "Ready", statusQualifier: "",
    statusValid: true, priority: "P1", owners: [], repositories: [], project: "observatory", projects: [],
    dependencies: dependencies.map((id) => dependency(id)), dependencyResidue: [], outcome: "",
    raw: {}, statusCell: null, priorityCell: null, outcomeCell: null, readiness: "startable",
    qwen3CoderNextReady: false,
    packetMetadata: { workKind: null, estimatedChangedLoc: null, sizeException: null, splitTaskIds: [], files: [], issues: [] },
    executionReadiness: "unassessed", workKind: null, estimatedChangedLoc: null, sizeException: null,
    readinessCheckedAt: null, executionBlockers: [], ...changes,
  });
}

const permutations = ["ABC", "ACB", "BAC", "BCA", "CAB", "CBA"];

describe("dependency graph cycle membership", () => {
  it.each(permutations.flatMap((order) => ["BC", "CB"].map((adjacency) => [order, adjacency])))
    ("includes the complete overlapping component for rows %s and A dependencies %s", (order, adjacency) => {
      const rows = freeze([...order].map((id) => task(id, [...(id === "A" ? adjacency : id === "B" ? "A" : "B")])));
      const before = JSON.stringify({ rows, workflow });
      const graph = buildDependencyGraph(rows, workflow);
      expect(graph.cycleIds).toEqual(new Set(["A", "B", "C"]));
      expect(graph.displayEdges).toHaveLength(4);
      expect(graph.displayEdges.every((edge) => !edge.actionable && edge.uncertainty.includes("cycle"))).toBe(true);
      for (const id of order) {
        expect(graph.upstreamOf(id)).toEqual(new Set());
        expect(graph.actionableFanOut(id)).toBe(0);
      }
      expect(buildDependencyGraph(rows, workflow).displayEdges).toEqual(graph.displayEdges);
      expect(JSON.stringify({ rows, workflow })).toBe(before);
    });

  it("excludes an acyclic downstream dependant while retaining its uncertain edge", () => {
    const graph = buildDependencyGraph([task("A", ["B"]), task("B", ["A"]), task("C", ["B"])], workflow);
    expect(graph.cycleIds).toEqual(new Set(["A", "B"]));
    expect(graph.directPrerequisiteEntries("C")).toMatchObject([
      { prerequisite: { id: "B" }, actionable: false, uncertainty: ["cycle"] },
    ]);
    expect(graph.directPrerequisites("C")).toEqual([]);
    expect(graph.directUncertainDependants("B").map((row) => row.id)).toEqual(["A", "C"]);
    expect(graph.upstreamOf("C").size).toBe(0);
    expect(graph.actionableFanOut("B")).toBe(0);
  });

  it("classifies disconnected cycles without including isolated or missing identities", () => {
    const graph = buildDependencyGraph([
      task("A", ["B"]), task("B", ["A"]), task("C", ["D"]), task("D", ["C"]),
      task("E"), task("F", [], { dependencies: [dependency("missing", { resolved: false })] }),
    ], workflow);
    expect(graph.cycleIds).toEqual(new Set(["A", "B", "C", "D"]));
    expect(graph.tasksById.has("missing")).toBe(false);
    expect(graph.displayEdges).toHaveLength(4);
  });

  it("excludes duplicate ledger identities from nodes and structural cycles", () => {
    const graph = buildDependencyGraph([task("A", ["B"]), task("B", ["A"]), task("B", ["A"])], workflow);
    expect([...graph.tasksById.keys()]).toEqual(["A"]);
    expect(graph.cycleIds.size).toBe(0);
    expect(graph.displayEdges).toEqual([]);
  });

  it.each([
    ["gate", { dependencies: [dependency("B", { gate: "reviewed" })] }],
    ["duplicate", { dependencies: [dependency("B", { duplicate: true }), dependency("B", { duplicate: true })] }],
    ["residue", { dependencyResidue: ["approval required"] }],
  ] satisfies readonly (readonly [string, Partial<Task>])[])("retains structural cycles with %s uncertainty", (reason, changes) => {
    const graph = buildDependencyGraph([task("A", ["B"], changes), task("B", ["A"])], workflow);
    expect(graph.cycleIds).toEqual(new Set(["A", "B"]));
    expect(graph.displayEdges).toHaveLength(2);
    expect(graph.directPrerequisiteEntries("A")[0]?.uncertainty).toEqual([reason, "cycle"]);
    expect(graph.displayEdges.every((edge) => !edge.actionable)).toBe(true);
    expect(graph.actionableFanOut("A")).toBe(0);
  });

  it("keeps self-only dependencies invisible and self-contaminated relationships non-actionable", () => {
    const self = buildDependencyGraph([task("A", ["A"])], workflow);
    expect(self.cycleIds.size).toBe(0);
    expect(self.displayEdges).toEqual([]);
    const graph = buildDependencyGraph([task("A", ["A", "B"]), task("B")], workflow);
    expect(graph.cycleIds.size).toBe(0);
    expect(graph.directPrerequisiteEntries("A")).toMatchObject([{ actionable: false, uncertainty: ["self"] }]);
    expect(graph.actionableFanOut("B")).toBe(0);
  });

  it("preserves diamond impact deduplication and priority/id sorting", () => {
    const graph = buildDependencyGraph([
      task("D", ["C", "B"]), task("C", ["A"], { priority: "P0" }), task("B", ["A"]), task("A"),
    ], workflow);
    expect(graph.cycleIds.size).toBe(0);
    expect(graph.directPrerequisites("D").map((row) => row.id)).toEqual(["C", "B"]);
    expect(graph.directOpenDependants("A").map((row) => row.id)).toEqual(["C", "B"]);
    expect(graph.directDependantEntries("A").map((edge) => edge.dependant.id)).toEqual(["C", "B"]);
    expect(graph.upstreamOf("D")).toEqual(new Set(["A", "B", "C"]));
    expect(graph.actionableFanOut("A")).toBe(3);
    expect(graph.displayEdges.map((edge) => [edge.prerequisite.id, edge.dependant.id])).toEqual([
      ["A", "B"], ["A", "C"], ["B", "D"], ["C", "D"],
    ]);
  });

  it("distinguishes custom closed states from dependency-satisfied states", () => {
    const custom: Workflow = freeze({
      statusOrder: ["Open", "Held", "Landed", "Retired"], activeStatuses: ["Open"], blockedStatuses: ["Held"],
      closedStatuses: ["Landed", "Retired"], dependencySatisfiedStatuses: ["Landed"], priorityOrder: ["Urgent", "Later"],
    });
    const rows = freeze([
      task("A", [], { statusBase: "Landed" }), task("B", [], { statusBase: "Retired" }),
      task("C", ["A"], { statusBase: "Open" }), task("D", ["B"], { statusBase: "Open" }),
    ]);
    const before = JSON.stringify({ rows, custom });
    const graph = buildDependencyGraph(rows, custom);
    expect(graph.directPrerequisites("C").map((row) => row.id)).toEqual(["A"]);
    expect(graph.directPrerequisiteEntries("D")).toMatchObject([{ actionable: false, uncertainty: ["closed"] }]);
    expect(graph.upstreamOf("C")).toEqual(new Set(["A"]));
    expect(graph.upstreamOf("D").size).toBe(0);
    for (const id of ["A", "B"]) {
      expect(graph.directDependantEntries(id)).toEqual([]);
      expect(graph.actionableFanOut(id)).toBe(0);
    }
    expect(JSON.stringify({ rows, custom })).toBe(before);
  });

  it.each([false, true])("handles a 10000-node graph without recursive overflow (ring=%s)", (ring) => {
    const rows = freeze(Array.from({ length: 10_000 }, (_, index) =>
      task(String(index), index < 9_999 ? [String(index + 1)] : ring ? ["0"] : [])));
    const graph = buildDependencyGraph(rows, workflow);
    expect(graph.cycleIds).toEqual(new Set(ring ? rows.map((row) => row.id) : []));
    expect(graph.displayEdges).toHaveLength(ring ? 10_000 : 9_999);
    expect(graph.upstreamOf("0").size).toBe(ring ? 0 : 9_999);
    expect(graph.actionableFanOut("9999")).toBe(ring ? 0 : 9_999);
  });
});
