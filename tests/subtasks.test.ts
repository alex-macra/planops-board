import { describe, expect, it } from "vitest";

import { extractDetailBlocks } from "../server/ledger/detail.ts";
import { parseSubtasks } from "../server/ledger/subtasks.ts";
import { buildBoard, type SourceDocument } from "../server/ledger/model.ts";

function parse(lines: readonly string[]) {
  const markdown = ["### POB-AUTH-003 - Inline authoring", "", ...lines].join("\n");
  const block = extractDetailBlocks(markdown.split("\n"), "plans/fixture.md")[0]!;
  return parseSubtasks(block);
}

describe("subtask checklist parsing", () => {
  it("parses id, parent, title, done state and owner", () => {
    const { subtasks, malformed } = parse([
      "- **Subtasks:**",
      "  - [ ] POB-AUTH-003.1 Add-story, add-task, add-subtask affordances",
      "  - [x] POB-AUTH-003.2 Sentence builder writes the block [@claude]",
    ]);
    expect(malformed).toEqual([]);
    expect(subtasks).toEqual([
      {
        id: "POB-AUTH-003.1",
        parentTaskId: "POB-AUTH-003",
        title: "Add-story, add-task, add-subtask affordances",
        done: false,
        owner: null,
      },
      {
        id: "POB-AUTH-003.2",
        parentTaskId: "POB-AUTH-003",
        title: "Sentence builder writes the block",
        done: true,
        owner: "claude",
      },
    ]);
  });

  it("reads an uppercase done marker", () => {
    expect(parse(["- **Subtasks:**", "  - [X] POB-AUTH-003.1 Done"]).subtasks[0]?.done).toBe(true);
  });

  it("reports a checklist ID under the wrong parent instead of attaching it", () => {
    const result = parse(["- **Subtasks:**", "  - [ ] POB-AUTH-004.1 Belongs to another task"]);
    expect(result).toEqual({ subtasks: [], malformed: ["[ ] POB-AUTH-004.1 Belongs to another task"] });
    const board = boardWith(["- **Subtasks:**", "  - [ ] POB-AUTH-004.1 Belongs to another task"]);
    expect(board.tasks.find((candidate) => candidate.id === "POB-AUTH-003")?.subtasks).toEqual([]);
    expect(board.issues).toContainEqual(expect.objectContaining({ kind: "subtask-malformed", taskId: "POB-AUTH-003" }));
  });

  it.each(["  - [ ] POB-AUTH-003.1", "  - [ ] POB-AUTH-003.1 [@alex]"])
  ("reports a missing title in %s as malformed", (line) => {
    const result = parse(["- **Subtasks:**", line]);
    expect(result).toEqual({ subtasks: [], malformed: [line.trim().replace(/^- /, "")] });
    const board = boardWith(["- **Subtasks:**", line]);
    expect(board.tasks.find((candidate) => candidate.id === "POB-AUTH-003")?.subtasks).toEqual([]);
    expect(board.issues).toContainEqual(expect.objectContaining({ kind: "subtask-malformed", taskId: "POB-AUTH-003" }));
  });

  it("reports a malformed line instead of dropping it, and counts the rest", () => {
    const { subtasks, malformed } = parse([
      "- **Subtasks:**",
      "  - [ ] POB-AUTH-003.1 A real subtask",
      "  - [ ] missing the dotted id",
      "  - a bare bullet with no checkbox",
    ]);
    expect(subtasks).toHaveLength(1);
    expect(subtasks[0]?.id).toBe("POB-AUTH-003.1");
    expect(malformed).toEqual(["[ ] missing the dotted id", "a bare bullet with no checkbox"]);
  });

  it("returns nothing when the block has no Subtasks field", () => {
    expect(parse(["- **Scope:** No checklist here."])).toEqual({ subtasks: [], malformed: [] });
  });
});

function boardWith(detailLines: readonly string[]) {
  const source: SourceDocument = {
    path: "plans/fixture.md",
    sha256: "a".repeat(64),
    text: [
      "# Fictional fixture",
      "",
      "| ID | Priority | Status | Dependencies | Required outcome |",
      "|---|---:|---|---|---|",
      "| `POB-AUTH-003` | P1 | Ready | None | Inline authoring. |",
      "",
      "### POB-AUTH-003 - Inline authoring",
      "",
      ...detailLines,
      "",
    ].join("\n"),
  };
  return buildBoard([source], new Set(), [], "2026-10-22T12:00:00.000Z");
}

describe("per-task subtask exposure", () => {
  it("attaches the checklist to the task so the board can count it", () => {
    const board = boardWith([
      "- **Subtasks:**",
      "  - [x] POB-AUTH-003.1 First",
      "  - [ ] POB-AUTH-003.2 Second",
    ]);
    const task = board.tasks.find((candidate) => candidate.id === "POB-AUTH-003")!;
    expect(task.subtasks).toHaveLength(2);
    expect(task.subtasks.filter((subtask) => subtask.done)).toHaveLength(1);
    expect(board.issues.some((issue) => issue.kind === "subtask-malformed")).toBe(false);
  });

  it("raises a data-quality issue for a malformed checklist line", () => {
    const board = boardWith(["- **Subtasks:**", "  - [ ] not a subtask id"]);
    const task = board.tasks.find((candidate) => candidate.id === "POB-AUTH-003")!;
    expect(task.subtasks).toEqual([]);
    const issue = board.issues.find((candidate) => candidate.kind === "subtask-malformed");
    expect(issue).toMatchObject({ kind: "subtask-malformed", taskId: "POB-AUTH-003", file: "plans/fixture.md" });
  });

  it("leaves a task with no checklist an empty array", () => {
    const board = boardWith(["- **Scope:** Nothing to split yet."]);
    expect(board.tasks.find((candidate) => candidate.id === "POB-AUTH-003")!.subtasks).toEqual([]);
  });
});
