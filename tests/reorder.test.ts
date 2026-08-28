import { describe, expect, it } from "vitest";

import { moveRow } from "../server/ledger/patch.ts";
import { targetLine } from "../src/views/Backlog.tsx";

const TABLE = [
  "# Fictional plan",
  "",
  "| ID | Status |",
  "|---|---|",
  "| `ORB-1` | Ready |",
  "| `ORB-2` | Ready |",
  "| `ORB-3` | Ready |",
  "| `ORB-4` | Ready |",
  "",
].join("\n");

function order(text: string): string[] {
  return [...text.matchAll(/`(ORB-\d)`/g)].map((match) => match[1]!);
}

describe("reorder target calculation", () => {
  it.each([
    [9, 5, "top", 5],
    [9, 5, "bottom", 6],
    [5, 9, "bottom", 9],
    [5, 9, "top", 8],
  ] as const)("maps source %s and target %s at %s", (source, target, edge, expected) => {
    expect(targetLine(source, target, edge)).toBe(expected);
  });

  it("recognizes adjacent and same-row no-ops", () => {
    expect(targetLine(5, 5, "top")).toBeNull();
    expect(targetLine(5, 4, "bottom")).toBeNull();
    expect(targetLine(5, 6, "top")).toBeNull();
  });

  it("places a lower row above the requested target", () => {
    const line = targetLine(8, 6, "top")!;
    expect(order(moveRow(TABLE, { fromLine: 8, toLine: line }))).toEqual([
      "ORB-1",
      "ORB-4",
      "ORB-2",
      "ORB-3",
    ]);
  });

  it("places an upper row below the requested target", () => {
    const line = targetLine(5, 7, "bottom")!;
    expect(order(moveRow(TABLE, { fromLine: 5, toLine: line }))).toEqual([
      "ORB-2",
      "ORB-3",
      "ORB-1",
      "ORB-4",
    ]);
  });

  it("undoes every move with the opposite move", () => {
    for (const from of [5, 6, 7, 8]) {
      for (const to of [5, 6, 7, 8]) {
        const moved = moveRow(TABLE, { fromLine: from, toLine: to });
        expect(moveRow(moved, { fromLine: to, toLine: from })).toBe(TABLE);
      }
    }
  });
});
