import { describe, expect, test } from "vitest";

import type { LastChange, Task } from "../shared/contracts.ts";
import {
  isActiveStatus,
  selectStaleTasks,
  selectStartableTasks,
  taskFanOut,
} from "../shared/task-selectors.ts";
import { toBoardResponse } from "../server/board-response.ts";
import { buildBoard, type SourceDocument } from "../server/ledger/model.ts";
import { buildNow, type NowBoard } from "../src/now.ts";

const NOW = new Date("2026-08-28T12:00:00.000Z");

const WORKFLOW = {
  statusOrder: ["Ready", "In progress", "Blocked", "Deferred", "Complete"],
  activeStatuses: ["Ready", "In progress"],
  blockedStatuses: ["Blocked"],
  closedStatuses: ["Deferred", "Complete"],
  dependencySatisfiedStatuses: ["Complete"],
  priorityOrder: ["P0", "P1", "P2", "P3"],
};

function parityBoard() {
  const source: SourceDocument = {
    path: "plans/selectors.md",
    sha256: "b".repeat(64),
    text: [
      "# Selector parity fixture",
      "",
      "| ID | Priority | Status | Owner | Dependencies | Required outcome |",
      "|---|---:|---|---|---|---|",
      "| `SEL-001` | P1 | Ready | demo-app | None | Root with two dependants. |",
      "| `SEL-002` | P1 | Ready | demo-app | `SEL-001` | Waiting dependant. |",
      "| `SEL-003` | P0 | In progress | demo-app | `SEL-002` | Transitive dependant. |",
      "| `SEL-004` | P1 | Ready | demo-app | None | Root with one dependant. |",
      "| `SEL-005` | P2 | Ready | demo-app | `SEL-004` | Second dependant. |",
      "| `SEL-014` | P1 | In progress | demo-app | None | Tie breaker listed first. |",
      "| `SEL-006` | P1 | Ready | demo-app | None | Tie breaker listed second. |",
      "| `SEL-008` | P9 | Ready | demo-app | None | Unknown priority listed first. |",
      "| `SEL-007` |  | Ready | Design team | None | Missing priority, role owner. |",
      "| `SEL-009` | P1 |  | demo-app | None | Missing status. |",
      "| `SEL-010` | P0 | Deferred | demo-app | None | Deferred prerequisite. |",
      "| `SEL-011` | P0 | Ready | demo-app | `SEL-010` | Waits on a deferred row. |",
      "| `SEL-012` | P0 | Blocked | demo-app | None | Blocked row. |",
      "| `SEL-013` | P0 | Complete | demo-app | None | Closed row. |",
      "",
    ].join("\n"),
  };
  return toBoardResponse(buildBoard(
    [source],
    new Set(["demo-app"]),
    [],
    "2026-08-28T12:00:00.000Z",
    WORKFLOW,
  ));
}

function change(date: string): LastChange {
  return { date, sha: null, subject: null };
}

const HISTORY: Readonly<Record<string, LastChange>> = {
  "SEL-001": change("2026-08-22T12:00:00.000Z"),
  "SEL-002": change("2026-08-21T12:00:00.000Z"),
  "SEL-005": change("2026-08-21T12:00:00.001Z"),
  "SEL-003": change("2026-08-10T12:00:00.000Z"),
  "SEL-006": change("2026-08-18T12:00:00.000Z"),
  "SEL-014": change("2026-08-18T12:00:00.000Z"),
  "SEL-011": change("2026-08-18T12:00:00.000Z"),
  "SEL-008": change("not a date"),
  "SEL-007": change("2026-09-01T12:00:00.000Z"),
  "SEL-009": change("2026-07-01T12:00:00.000Z"),
  "SEL-010": change("2026-07-01T12:00:00.000Z"),
  "SEL-012": change("2026-07-01T12:00:00.000Z"),
  "SEL-013": change("2026-07-01T12:00:00.000Z"),
};

function nowShape(now: NowBoard) {
  return {
    groups: now.groups.map((group) => [
      group.id,
      group.rows.map((row) => [row.task.id, row.note]),
    ]),
    shown: now.shown,
    total: now.total,
    folded: now.folded,
    historyReady: now.historyReady,
  };
}

function task(board: ReturnType<typeof parityBoard>, id: string): Task {
  const match = board.tasks.find((candidate) => candidate.id === id);
  if (!match) throw new Error(`missing fixture task ${id}`);
  return match;
}

describe("task selector parity", () => {
  test("fixture rows carry the readiness the selectors depend on", () => {
    const board = parityBoard();

    expect(board.tasks.map((entry) => [entry.id, entry.statusBase, entry.priority, entry.readiness]))
      .toEqual([
        ["SEL-001", "Ready", "P1", "startable"],
        ["SEL-002", "Ready", "P1", "waiting"],
        ["SEL-003", "In progress", "P0", "waiting"],
        ["SEL-004", "Ready", "P1", "startable"],
        ["SEL-005", "Ready", "P2", "waiting"],
        ["SEL-014", "In progress", "P1", "startable"],
        ["SEL-006", "Ready", "P1", "startable"],
        ["SEL-008", "Ready", "P9", "startable"],
        ["SEL-007", "Ready", null, "startable"],
        ["SEL-009", null, "P1", "needs-gate-check"],
        ["SEL-010", "Deferred", "P0", null],
        ["SEL-011", "Ready", "P0", "waiting"],
        ["SEL-012", "Blocked", "P0", "needs-gate-check"],
        ["SEL-013", "Complete", "P0", null],
      ]);
    expect(task(board, "SEL-007").repositories).toEqual([]);
  });

  test("fan-out counts open dependants and gives closed rows none", () => {
    const board = parityBoard();

    expect([...taskFanOut(board)]).toEqual([
      ["SEL-001", 2],
      ["SEL-002", 1],
      ["SEL-003", 0],
      ["SEL-004", 1],
      ["SEL-005", 0],
      ["SEL-014", 0],
      ["SEL-006", 0],
      ["SEL-008", 0],
      ["SEL-007", 0],
      ["SEL-009", 0],
      ["SEL-010", 0],
      ["SEL-011", 0],
      ["SEL-012", 0],
      ["SEL-013", 0],
    ]);
  });

  test("startable orders by fan-out, then priority, then ID, with null and unknown priority last", () => {
    const board = parityBoard();

    expect(selectStartableTasks(board).map(({ task: entry, fanOut }) => [entry.id, fanOut])).toEqual([
      ["SEL-001", 2],
      ["SEL-004", 1],
      ["SEL-006", 0],
      ["SEL-014", 0],
      ["SEL-007", 0],
      ["SEL-008", 0],
    ]);
  });

  test("stale orders by age, then priority, then ID, and excludes unusable timestamps", () => {
    const board = parityBoard();
    const expected = [
      ["SEL-003", 18],
      ["SEL-011", 10],
      ["SEL-006", 10],
      ["SEL-014", 10],
      ["SEL-002", 7],
    ];

    const fromRecord = selectStaleTasks(board, HISTORY, NOW);
    const fromFunction = selectStaleTasks(board, (entry) => HISTORY[entry.id], NOW.getTime());

    expect(fromRecord.map(({ task: entry, ageDays }) => [entry.id, ageDays])).toEqual(expected);
    expect(fromFunction.map(({ task: entry, ageDays }) => [entry.id, ageDays])).toEqual(expected);
    expect(fromFunction).toEqual(fromRecord);
  });

  test("Now groups, counts and folds with history", () => {
    const board = parityBoard();

    expect(nowShape(buildNow(board, board.tasks, HISTORY, NOW.getTime()))).toEqual({
      groups: [
        ["stale", [
          ["SEL-003", "18d untouched"],
          ["SEL-011", "10d untouched"],
          ["SEL-006", "10d untouched"],
          ["SEL-014", "10d untouched"],
          ["SEL-002", "7d untouched"],
        ]],
        ["person", [["SEL-007", "Design team"]]],
        ["unblocks", [["SEL-001", "unblocks 2"], ["SEL-004", "unblocks 1"]]],
        ["start", [["SEL-008", null]]],
        ["land", [["SEL-005", null]]],
      ],
      shown: 10,
      total: 14,
      folded: [
        { key: "closed", label: "in a closed status", count: 2 },
        { key: "needs-gate-check", label: "needing a gate check", count: 2 },
      ],
      historyReady: true,
    });
  });

  test("active status predicate accepts only configured active statuses", () => {
    const board = parityBoard();

    expect(isActiveStatus(task(board, "SEL-009"), board.workflow)).toBe(false);
    expect(isActiveStatus(task(board, "SEL-001"), board.workflow)).toBe(true);
    expect(isActiveStatus(task(board, "SEL-014"), board.workflow)).toBe(true);
    expect(isActiveStatus(task(board, "SEL-012"), board.workflow)).toBe(false);
    expect(isActiveStatus(task(board, "SEL-010"), board.workflow)).toBe(false);
    expect(isActiveStatus(task(board, "SEL-013"), board.workflow)).toBe(false);
    expect(isActiveStatus({ ...task(board, "SEL-001"), statusBase: "Mystery" }, board.workflow)).toBe(false);
  });

  test("Now groups, counts and folds without history", () => {
    const board = parityBoard();

    expect(nowShape(buildNow(board, board.tasks, {}, NOW.getTime()))).toEqual({
      groups: [
        ["person", [["SEL-007", "Design team"]]],
        ["unblocks", [["SEL-001", "unblocks 2"], ["SEL-002", "unblocks 1"], ["SEL-004", "unblocks 1"]]],
        ["start", [["SEL-006", null], ["SEL-014", null], ["SEL-008", null]]],
        ["land", [["SEL-003", null], ["SEL-011", null], ["SEL-005", null]]],
      ],
      shown: 10,
      total: 14,
      folded: [
        { key: "closed", label: "in a closed status", count: 2 },
        { key: "needs-gate-check", label: "needing a gate check", count: 2 },
      ],
      historyReady: false,
    });
  });
});
