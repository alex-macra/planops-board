import { describe, expect, it } from "vitest";

import { DEFAULT_WORKFLOW, type WorkflowConfig } from "../shared/config.ts";
import { buildBoard, type SourceDocument } from "../server/ledger/model.ts";
import { readinessReasons } from "../src/readiness.ts";
import type { Board as BrowserBoard } from "../src/api.ts";

function row(id: string, status: string, dependencies = "None"): string {
  return `| \`${id}\` | P1 | ${status} | ${dependencies} | Fictional outcome. |`;
}

function board(rows: readonly string[], workflow: WorkflowConfig = DEFAULT_WORKFLOW) {
  const source: SourceDocument = {
    path: "plans/fixture.md",
    sha256: "a".repeat(64),
    text: [
      "# Fictional fixture",
      "",
      "| ID | Priority | Status | Dependencies | Required outcome |",
      "|---|---:|---|---|---|",
      ...rows,
      "",
    ].join("\n"),
  };
  return buildBoard([source], new Set(), [], "2026-08-20T12:00:00.000Z", workflow);
}

function readiness(rows: readonly string[], id: string, workflow?: WorkflowConfig) {
  return board(rows, workflow).tasks.find((task) => task.id === id)?.readiness;
}

describe("configured readiness", () => {
  it("starts when every dependency has a satisfied status", () => {
    expect(readiness([row("ORB-001", "Complete"), row("ORB-002", "Ready", "`ORB-001`")], "ORB-002"))
      .toBe("startable");
  });

  it("waits for an open dependency", () => {
    expect(readiness([row("ORB-001", "In progress"), row("ORB-002", "Ready", "`ORB-001`")], "ORB-002"))
      .toBe("waiting");
  });

  it("uses custom satisfied and closed states", () => {
    const workflow: WorkflowConfig = {
      statusOrder: ["Open", "Moving", "Held", "Landed"],
      activeStatuses: ["Open", "Moving"],
      blockedStatuses: ["Held"],
      closedStatuses: ["Landed"],
      dependencySatisfiedStatuses: ["Landed"],
      priorityOrder: ["P1"],
    };
    expect(readiness([row("ORB-001", "Landed"), row("ORB-002", "Open", "`ORB-001`")], "ORB-002", workflow))
      .toBe("startable");
  });

  it.each([
    ["`ORB-999`", "dangling dependency"],
    ["`ORB-001@reviewed`", "unchecked gate"],
    ["`ORB-001`; approval", "dependency residue"],
  ])("requires a gate check for %s", (dependencies) => {
    expect(readiness([row("ORB-001", "Complete"), row("ORB-002", "Ready", dependencies)], "ORB-002"))
      .toBe("needs-gate-check");
  });

  it("requires a gate check for a cycle", () => {
    expect(readiness([row("ORB-001", "Ready", "`ORB-002`"), row("ORB-002", "Ready", "`ORB-001`")], "ORB-001"))
      .toBe("needs-gate-check");
  });

  it("returns null for a configured closed status", () => {
    expect(readiness([row("ORB-001", "Complete")], "ORB-001")).toBeNull();
  });
});

describe("readiness explanations", () => {
  it("names the open dependency", () => {
    const fixture = board([row("ORB-001", "In progress"), row("ORB-002", "Ready", "`ORB-001`")]);
    const task = fixture.tasks.find((entry) => entry.id === "ORB-002")!;
    expect(readinessReasons(fixture as unknown as BrowserBoard, task)).toEqual([
      "ORB-001 is In progress.",
    ]);
  });

  it("names missing rows, gates, and residue", () => {
    const fixture = board([
      row("ORB-001", "Complete"),
      row("ORB-002", "Ready", "`ORB-001@reviewed`; approval; `ORB-999`"),
    ]);
    const task = fixture.tasks.find((entry) => entry.id === "ORB-002")!;
    expect(readinessReasons(fixture as unknown as BrowserBoard, task)).toEqual(expect.arrayContaining([
      "Dependency text contains unparsed content that needs review.",
      "ORB-001 also requires the unchecked @reviewed gate.",
      "ORB-999 is not defined in the planning corpus.",
    ]));
  });
});
