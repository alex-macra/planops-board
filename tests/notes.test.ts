import { describe, expect, it } from "vitest";

import { extractDetailBlocks, notesOf } from "../server/ledger/detail.ts";
import { noteLines, NoteError, planNote } from "../server/ledger/notes.ts";
import { insertLines } from "../server/ledger/patch.ts";

const WITH_BLOCKS = [
  "# Observatory",
  "",
  "| ID | Status |",
  "|---|---|",
  "| `ORB-001` | Ready |",
  "| `ORB-002` | Ready |",
  "",
  "## Work items",
  "",
  "### ORB-001 - First observation",
  "",
  "- **Scope:** Record the first observation.",
  "",
  "### ORB-002 - Second observation",
  "",
  "- **Scope:** Record the second observation.",
  "",
  "## Appendix",
  "",
].join("\n");

const WITHOUT_BLOCKS = [
  "# Observatory",
  "",
  "| ID | Status |",
  "|---|---|",
  "| `ORB-001` | Ready |",
  "",
].join("\n");

function apply(text: string, request: Parameters<typeof planNote>[1]): string {
  return insertLines(text, planNote(text, request).insert);
}

describe("note formatting", () => {
  it("writes a dated note bullet", () => {
    expect(noteLines("Cloud cover cleared.", "2026-08-20")).toEqual([
      "- **Note (2026-08-20):** Cloud cover cleared.",
    ]);
  });

  it("wraps long notes with indented continuation lines", () => {
    const lines = noteLines("observation ".repeat(20), "2026-08-20");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.length <= 79)).toBe(true);
    expect(lines.slice(1).every((line) => line.startsWith("  "))).toBe(true);
  });

  it("collapses multiline input into one paragraph", () => {
    expect(noteLines("first\n\nsecond", "2026-08-20")).toEqual([
      "- **Note (2026-08-20):** first second",
    ]);
  });

  it("rejects an empty note", () => {
    expect(() => noteLines("  \n ", "2026-08-20")).toThrow(NoteError);
  });
});

describe("note placement", () => {
  it("appends to the selected existing block", () => {
    const updated = apply(WITH_BLOCKS, {
      taskId: "ORB-001",
      text: "The lens is ready.",
      date: "2026-08-20",
    });
    const blocks = extractDetailBlocks(updated.split("\n"), "plans/fixture.md");
    expect(notesOf(blocks.find((block) => block.id === "ORB-001")!)).toHaveLength(1);
    expect(notesOf(blocks.find((block) => block.id === "ORB-002")!)).toHaveLength(0);
  });

  it("creates a titled block alongside existing blocks", () => {
    const updated = apply(WITH_BLOCKS, {
      taskId: "ORB-003",
      title: "Third observation",
      text: "A new note.",
      date: "2026-08-20",
    });
    expect(updated).toContain("### ORB-003 - Third observation");
    expect(updated.indexOf("### ORB-003")).toBeLessThan(updated.indexOf("## Appendix"));
  });

  it("opens one Notes section when the document has no blocks", () => {
    const once = apply(WITHOUT_BLOCKS, {
      taskId: "ORB-001",
      title: "First observation",
      text: "One.",
    });
    const twice = apply(once, {
      taskId: "ORB-002",
      title: "Second observation",
      text: "Two.",
    });
    expect(twice.split("\n").filter((line) => line === "## Notes")).toHaveLength(1);
  });

  it("requires a title before creating a block", () => {
    expect(() => planNote(WITH_BLOCKS, { taskId: "ORB-003", text: "A note." })).toThrow(
      NoteError,
    );
  });

  it("guards the insertion point with the expected line text", () => {
    const plan = planNote(WITH_BLOCKS, { taskId: "ORB-001", text: "A note." });
    expect(plan.insert).toMatchObject({
      afterLine: 12,
      expectedAfterText: "- **Scope:** Record the first observation.",
    });
  });
});
