import { describe, expect, it } from "vitest";

import { splitRow } from "../server/ledger/parse.ts";
import {
  ConflictError,
  insertLines,
  moveRow,
  patchCells,
  PatchError,
} from "../server/ledger/patch.ts";

const LEDGER = [
  "# Fictional plan",
  "",
  "| ID | Priority | Status | Required outcome |",
  "|---|---:|---|---|",
  "| `ORB-001` | P0 | Ready | First. |",
  "| `ORB-002` | P1 | Blocked | Second. |",
  "| `ORB-003` | P2 | Complete | Third. |",
  "",
].join("\n");

describe("cell patching", () => {
  it("changes only the target value", () => {
    const updated = patchCells(LEDGER, [
      { line: 5, column: 2, expected: "Ready", value: "In progress" },
    ]);
    expect(updated.split("\n")[4]).toBe("| `ORB-001` | P0 | In progress | First. |");
    expect(updated.split("\n").filter((_, index) => index !== 4)).toEqual(
      LEDGER.split("\n").filter((_, index) => index !== 4),
    );
  });

  it("preserves backticks and alignment padding", () => {
    const text = "|  `ORB-001`  |  `Ready`      |  x  |";
    expect(
      patchCells(text, [{ line: 1, column: 1, expected: "Ready", value: "Complete" }]),
    ).toBe("|  `ORB-001`  |  `Complete`      |  x  |");
  });

  it("escapes a pipe without adding a column", () => {
    const updated = patchCells(LEDGER, [
      { line: 5, column: 3, expected: "First.", value: "A | B" },
    ]);
    const row = splitRow(updated.split("\n")[4]!)!;
    expect(row.cells).toHaveLength(4);
    expect(row.cells[3]).toBe("A | B");
  });

  it("rejects line breaks, stale values, and invalid coordinates", () => {
    expect(() =>
      patchCells(LEDGER, [{ line: 5, column: 2, expected: "Ready", value: "a\nb" }]),
    ).toThrow(PatchError);
    expect(() =>
      patchCells(LEDGER, [{ line: 5, column: 2, expected: "Queued", value: "Complete" }]),
    ).toThrow(ConflictError);
    expect(() =>
      patchCells(LEDGER, [{ line: 99, column: 2, expected: "", value: "Ready" }]),
    ).toThrow(ConflictError);
  });
});

describe("row moves", () => {
  it("reorders rows inside one table", () => {
    const updated = moveRow(LEDGER, { fromLine: 7, toLine: 5 });
    expect(updated.split("\n").slice(4, 7)).toEqual([
      "| `ORB-003` | P2 | Complete | Third. |",
      "| `ORB-001` | P0 | Ready | First. |",
      "| `ORB-002` | P1 | Blocked | Second. |",
    ]);
  });

  it("refuses a target outside the same table", () => {
    expect(() => moveRow(LEDGER, { fromLine: 5, toLine: 2 })).toThrow(PatchError);
  });
});

describe("line insertion", () => {
  const document = [
    "# Fictional plan",
    "",
    "### ORB-001 - First",
    "",
    "- **Scope:** Observe.",
    "",
    "```text",
    "sample",
    "```",
    "",
    "| ID | Status |",
    "|---|---|",
    "| `ORB-001` | Ready |",
    "",
  ].join("\n");

  it("inserts after the guarded anchor", () => {
    const updated = insertLines(document, {
      afterLine: 5,
      expectedAfterText: "- **Scope:** Observe.",
      lines: ["- **Note (2026-08-20):** Clear sky."],
    });
    expect(updated.split("\n")[5]).toBe("- **Note (2026-08-20):** Clear sky.");
  });

  it("rejects a stale anchor", () => {
    expect(() =>
      insertLines(document, {
        afterLine: 5,
        expectedAfterText: "- **Scope:** Changed.",
        lines: ["x"],
      }),
    ).toThrow(ConflictError);
  });

  it("rejects insertion inside a table or fenced block", () => {
    for (const afterLine of [7, 8, 9, 11, 12]) {
      expect(() =>
        insertLines(document, {
          afterLine,
          expectedAfterText: document.split("\n")[afterLine - 1]!,
          lines: ["x"],
        }),
      ).toThrow(PatchError);
    }
  });

  it("rejects multiline text and conflict markers", () => {
    expect(() =>
      insertLines(document, { afterLine: 2, expectedAfterText: "", lines: ["a\nb"] }),
    ).toThrow(PatchError);
    expect(() =>
      insertLines(document, { afterLine: 2, expectedAfterText: "", lines: ["<<<<<<< HEAD"] }),
    ).toThrow(PatchError);
  });
});
