import { describe, expect, it } from "vitest";

import { deliverySummaryFromFields } from "../shared/delivery-summary.ts";
import { buildBoard } from "../server/ledger/model.ts";
import { toBoardResponse } from "../server/board-response.ts";

const summary = {
  version: 1,
  runId: "run-2026-09-30-01",
  executor: "codex",
  phase: "review",
  outcome: "checks-passed",
  evidence: ["PR #12", "CI run 88"],
  nextGate: "merge",
  updatedAt: "2026-09-30T12:30:00.000Z",
  productRevision: "a".repeat(40),
} as const;

function boardWithDeliveryFields(fields: readonly string[]) {
  return buildBoard([{
    path: "plans/orbit.md",
    sha256: "a".repeat(64),
    text: [
      "# Orbit",
      "| ID | Priority | Status | Dependencies | Required outcome |",
      "|---|---|---|---|---|",
      "| ORB-001 | P1 | Ready | None | Record an orbit. |",
      "### ORB-001 - Local observation",
      ...fields,
    ].join("\n"),
  }], new Set());
}

describe("delivery summary v1", () => {
  it("parses the exact bounded detail field into the Board transport contract", () => {
    const board = boardWithDeliveryFields([`- **Delivery summary:** ${JSON.stringify(summary)}`]);
    expect(board.tasks[0]?.deliverySummary).toEqual(summary);
    expect(toBoardResponse(board).tasks[0]?.deliverySummary).toEqual(summary);
  });

  it.each([
    ["invalid JSON", "not-json"],
    ["unsupported version", JSON.stringify({ ...summary, version: 2 })],
    ["unknown executor", JSON.stringify({ ...summary, executor: "other" })],
    ["short product revision", JSON.stringify({ ...summary, productRevision: "abc" })],
    ["oversized field", JSON.stringify({ ...summary, outcome: "x".repeat(9_000) })],
  ])("ignores %s safely", (_label, value) => {
    const board = boardWithDeliveryFields([`- **Delivery summary:** ${value}`]);
    expect(board.tasks[0]?.deliverySummary).toBeNull();
  });

  it("ignores duplicate fields rather than choosing one", () => {
    const fields = [
      `- **Delivery summary:** ${JSON.stringify(summary)}`,
      `- **Delivery summary:** ${JSON.stringify({ ...summary, runId: "other-run" })}`,
    ];
    expect(boardWithDeliveryFields(fields).tasks[0]?.deliverySummary).toBeNull();
  });

  it("bounds evidence references and field multiplicity", () => {
    expect(deliverySummaryFromFields([
      { label: "Delivery summary", items: [JSON.stringify({ ...summary, evidence: ["e".repeat(1_001)] })] },
    ])).toBeNull();
    expect(deliverySummaryFromFields([
      { label: "Delivery summary", items: [JSON.stringify(summary), JSON.stringify(summary)] },
    ])).toBeNull();
  });
});
