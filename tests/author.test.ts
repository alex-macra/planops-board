import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handleApi } from "../server/api.ts";
import { loadBoard } from "../server/ledger/corpus.ts";
import { extractDetailBlocks } from "../server/ledger/detail.ts";
import { acquireLedgerLock, LockError } from "../server/ledger/lock.ts";
import { ConflictError, PatchError } from "../server/ledger/patch.ts";
import { applyWrite, ForbiddenPathError, ValidationError } from "../server/ledger/write.ts";
import { loadBoardRuntime } from "../server/runtime.ts";
import { disposableDemo, removeDisposableDemo } from "./fixture.ts";

const roots: string[] = [];
const file = "plans/moon-garden.md";

async function fixture(allowExternalValidator = false) {
  const root = await disposableDemo("work/author");
  roots.push(root);
  if (allowExternalValidator) {
    await writeFile(path.join(root, ".projects-board", "validate"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  const runtime = await loadBoardRuntime({ repo: root, allowExternalValidator });
  const absolute = path.join(root, file);
  const board = await loadBoard(runtime);
  const baseSha256 = board.documents.find((entry) => entry.path === file)!.sha256;
  return { root, runtime, absolute, baseSha256 };
}

const story = {
  operation: "create.story" as const,
  id: "MGA-S02",
  title: "Visitors compare habitats",
  outcome: "I can compare habitats",
  soThat: "I choose a suitable garden",
};

const task = {
  operation: "create.task" as const,
  id: "MGA-004",
  storyId: "MGA-S01",
  title: "Add habitat comparison",
  tableHeaderLine: 14,
  cells: {
    Priority: "P1",
    Status: "Ready",
    Dependencies: "None",
    "Repository / owner": "moon-garden-ui",
    "Required outcome": "Visitors compare habitats.",
  },
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeDisposableDemo));
});

describe("guarded authoring", () => {
  it("publishes eligible table coordinates and accepts the first row of an empty table", async () => {
    const { runtime, absolute } = await fixture();
    const original = await readFile(absolute, "utf8");
    const single = await loadBoard(runtime);
    expect(single.taskTables.filter((entry) => entry.file === file)).toEqual([{
      file, headerLine: 14,
      headers: ["ID", "Priority", "Status", "Dependencies", "Repository / owner", "Required outcome"],
    }]);

    const empty = [
      "## Additional task table",
      "| ID | Priority | Status | Dependencies | Repository / owner | Required outcome |",
      "| --- | --- | --- | --- | --- | --- |",
      "",
      "## Unsupported table",
      "| ID | Surprise |",
      "| --- | --- |",
      "",
    ].join("\n");
    await writeFile(absolute, original.replace("## Stories", `${empty}## Stories`));
    const withTables = await loadBoard(runtime);
    const choices = withTables.taskTables.filter((entry) => entry.file === file);
    expect(choices).toHaveLength(2);
    const second = choices.find((entry) => entry.headerLine !== 14)!;
    expect(second.headers).toEqual(choices[0]?.headers);
    const baseSha256 = withTables.documents.find((entry) => entry.path === file)!.sha256;
    const created = await applyWrite(runtime, { file, baseSha256, author: { ...task, id: "MGA-004", tableHeaderLine: second.headerLine } });
    const after = await readFile(absolute, "utf8");
    expect(after).toContain("| --- | --- | --- | --- | --- | --- |\n| `MGA-004` | P1 | Ready | None | moon-garden-ui | Visitors compare habitats. |");
    expect(created.sha256).toBe((await loadBoard(runtime)).documents.find((entry) => entry.path === file)?.sha256);
    expect((await loadBoard(runtime)).tasks.find((entry) => entry.id === "MGA-004")?.storyId).toBe("MGA-S01");

    await writeFile(absolute, original.replace("| ID |", "| Not ID |"));
    expect((await loadBoard(runtime)).taskTables.filter((entry) => entry.file === file)).toEqual([]);
  });

  it("creates a parseable story and refuses missing sentence fields", async () => {
    const { runtime, absolute, baseSha256 } = await fixture();
    const before = await readFile(absolute, "utf8");
    await applyWrite(runtime, { file, baseSha256, author: story });
    const after = await readFile(absolute, "utf8");
    expect(after).toContain("### MGA-S02 - Visitors compare habitats\n\n- **Outcome:** I can compare habitats\n- **So that:** I choose a suitable garden\n- **Delivered by:**");
    expect(after).toBe(before.replace("## Task details", "### MGA-S02 - Visitors compare habitats\n\n- **Outcome:** I can compare habitats\n- **So that:** I choose a suitable garden\n- **Delivered by:**\n\n## Task details"));
    expect((await loadBoard(runtime)).stories.filter((entry) => entry.id === story.id)).toHaveLength(1);
    const response = await handleApi(runtime, "POST", "/api/write", { ...story, id: "MGA-S03", outcome: "" });
    expect(response.status).toBe(400);
    expect(await readFile(absolute, "utf8")).toBe(after);
  });

  it("rejects HTML comments and Unicode next-line characters without hiding existing detail blocks", async () => {
    const { runtime, absolute, baseSha256 } = await fixture();
    const before = await readFile(absolute, "utf8");
    const beforeIds = extractDetailBlocks(before.split("\n"), file).map((block) => block.id);
    for (const unsafe of [
      { demo: "show <!--" },
      { demo: "show <!--hidden--> now" },
      { role: "gardener <!--hidden-->" },
      { demo: "show\u0085next line" },
    ]) {
      await expect(applyWrite(runtime, { file, baseSha256, author: { ...story, ...unsafe } })).rejects.toBeInstanceOf(PatchError);
      const after = await readFile(absolute, "utf8");
      expect(after).toBe(before);
      expect(extractDetailBlocks(after.split("\n"), file).map((block) => block.id)).toEqual(beforeIds);
    }
  });

  it("creates a row, detail block and same-file story link as one transaction", async () => {
    const { runtime, absolute, baseSha256 } = await fixture();
    const before = await readFile(absolute, "utf8");
    const response = await handleApi(runtime, "POST", "/api/write", { file, baseSha256, ...task });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const after = await readFile(absolute, "utf8");
    expect(after).toContain("| `MGA-004` | P1 | Ready | None | moon-garden-ui | Visitors compare habitats. |");
    expect(after).toContain("### MGA-004 - Add habitat comparison");
    expect(after).toContain("- **Delivered by:** `MGA-001`, `MGA-002`, `MGA-003`, `MGA-004`");
    expect(after.replace("| `MGA-004` | P1 | Ready | None | moon-garden-ui | Visitors compare habitats. |\n", "")
      .replace(", `MGA-004`", "")
      .replace("\n\n### MGA-004 - Add habitat comparison", "")).toBe(before);
    const board = await loadBoard(runtime);
    expect(board.tasks.find((entry) => entry.id === task.id)?.storyId).toBe(task.storyId);
    expect(board.stories.find((entry) => entry.id === task.storyId)?.taskIds).toContain(task.id);
  });

  it("links the first task to a newly created story", async () => {
    const { runtime, baseSha256 } = await fixture();
    const created = await applyWrite(runtime, { file, baseSha256, author: story });
    await applyWrite(runtime, { file, baseSha256: created.sha256, author: { ...task, storyId: story.id } });
    const board = await loadBoard(runtime);
    expect(board.stories.find((entry) => entry.id === story.id)?.taskIds).toEqual([task.id]);
    expect(board.tasks.find((entry) => entry.id === task.id)?.storyId).toBe(story.id);
  });

  it("creates and toggles a subtask while changing only the marker on toggle", async () => {
    const { runtime, absolute, baseSha256 } = await fixture();
    const beforeCreate = await readFile(absolute);
    const create = { operation: "create.subtask" as const, taskId: "MGA-002", id: "MGA-002.1", title: "Add [x] keyboard comparison", owner: "alex" };
    const created = await applyWrite(runtime, { file, baseSha256, author: create });
    const beforeToggle = await readFile(absolute, "utf8");
    expect(Buffer.from(beforeToggle)).toEqual(Buffer.from(beforeCreate.toString("utf8").replace(
      "- **Note (2026-08-20):** The empty-state wording still needs a final review.",
      "- **Note (2026-08-20):** The empty-state wording still needs a final review.\n\n- **Subtasks:**\n  - [ ] MGA-002.1 Add [x] keyboard comparison [@alex]",
    )));
    expect((await loadBoard(runtime)).tasks.find((entry) => entry.id === create.taskId)?.subtasks).toMatchObject([
      { id: create.id, title: create.title, owner: "alex", done: false },
    ]);
    await applyWrite(runtime, { file, baseSha256: created.sha256, author: { operation: "toggle.subtask", taskId: create.taskId, id: create.id } });
    const after = await readFile(absolute, "utf8");
    expect(after).toBe(beforeToggle.replace("  - [ ] MGA-002.1", "  - [x] MGA-002.1"));
    expect((await loadBoard(runtime)).tasks.find((entry) => entry.id === create.taskId)?.subtasks[0]?.done).toBe(true);
  });

  it("appends a sibling subtask without changing its first neighbor or the trailing newline", async () => {
    const { runtime, absolute, baseSha256 } = await fixture();
    const first = await applyWrite(runtime, { file, baseSha256, author: {
      operation: "create.subtask", taskId: "MGA-002", id: "MGA-002.1", title: "Keep this neighbor",
    } });
    const before = await readFile(absolute);
    await applyWrite(runtime, { file, baseSha256: first.sha256, author: {
      operation: "create.subtask", taskId: "MGA-002", id: "MGA-002.2", title: "New sibling",
    } });
    const after = await readFile(absolute);
    expect(after).toEqual(Buffer.from(before.toString("utf8").replace(
      "  - [ ] MGA-002.1 Keep this neighbor",
      "  - [ ] MGA-002.1 Keep this neighbor\n  - [ ] MGA-002.2 New sibling",
    )));
    expect(after.at(-1)).toBe(10);
    expect((await loadBoard(runtime)).tasks.find((entry) => entry.id === "MGA-002")?.subtasks).toMatchObject([
      { id: "MGA-002.1", done: false }, { id: "MGA-002.2", done: false },
    ]);
  });

  it("refuses stale digests, duplicate IDs, invalid table and cross-file story before mutation", async () => {
    const { runtime, absolute, baseSha256 } = await fixture();
    const before = await readFile(absolute, "utf8");
    await expect(applyWrite(runtime, { file, baseSha256: "a".repeat(64), author: story })).rejects.toBeInstanceOf(ConflictError);
    await expect(applyWrite(runtime, { file, baseSha256, author: { ...story, id: "MGA-S01" } })).rejects.toBeInstanceOf(PatchError);
    await expect(applyWrite(runtime, { file, baseSha256, author: { ...task, id: "MGA-001" } })).rejects.toBeInstanceOf(PatchError);
    await expect(applyWrite(runtime, { file, baseSha256, author: { ...task, tableHeaderLine: 9 } })).rejects.toBeInstanceOf(PatchError);
    await expect(applyWrite(runtime, { file, baseSha256, author: { ...task, storyId: "SHR-S01" } })).rejects.toBeInstanceOf(PatchError);
    await expect(applyWrite(runtime, { file, baseSha256, author: {
      operation: "create.subtask", taskId: "MGA-002", id: "MGA-002.1", title: "[@alex]",
    } })).rejects.toBeInstanceOf(PatchError);
    expect(await readFile(absolute, "utf8")).toBe(before);
  });

  it("refuses ambiguous story and malformed table anchors without partial task creation", async () => {
    const { runtime, absolute } = await fixture();
    const before = await readFile(absolute, "utf8");
    const duplicate = before.replace("## Task details", "### MGA-S01 - Duplicate story\n\n- **Outcome:** Duplicate\n- **So that:** Duplicate\n\n## Task details");
    await writeFile(absolute, duplicate);
    const duplicateSha = (await loadBoard(runtime)).documents.find((entry) => entry.path === file)!.sha256;
    await expect(applyWrite(runtime, { file, baseSha256: duplicateSha, author: task })).rejects.toBeInstanceOf(PatchError);
    expect(await readFile(absolute, "utf8")).toBe(duplicate);

    const malformed = before.replace("| `MGA-003` | P1 |", "| `MGA-003` | extra | P1 |");
    await writeFile(absolute, malformed);
    const malformedSha = (await loadBoard(runtime)).documents.find((entry) => entry.path === file)!.sha256;
    await expect(applyWrite(runtime, { file, baseSha256: malformedSha, author: task })).rejects.toBeInstanceOf(PatchError);
    expect(await readFile(absolute, "utf8")).toBe(malformed);
  });

  it("refuses malformed checklists, forbidden files and read-only requests", async () => {
    const { runtime, absolute, baseSha256 } = await fixture();
    const before = await readFile(absolute, "utf8");
    const broken = before.replace("- **Scope:** Add a keyboard-operable light-level filter.", "- **Subtasks:**\n  - [ ] missing id\n- **Scope:** Add a keyboard-operable light-level filter.");
    await writeFile(absolute, broken);
    const board = await loadBoard(runtime);
    const current = board.documents.find((entry) => entry.path === file)!.sha256;
    await expect(applyWrite(runtime, { file, baseSha256: current, author: { operation: "create.subtask", taskId: "MGA-002", id: "MGA-002.1", title: "Valid" } })).rejects.toBeInstanceOf(PatchError);
    expect(await readFile(absolute, "utf8")).toBe(broken);
    await expect(applyWrite(runtime, { file: "README.md", baseSha256, author: story })).rejects.toBeInstanceOf(ForbiddenPathError);
    const readOnly = await loadBoardRuntime({ repo: runtime.repositoryRoot, readOnly: true });
    expect((await handleApi(readOnly, "POST", "/api/write", { file, baseSha256: current, ...story })).status).toBe(403);
  });

  it("lets exactly one same-base author win and respects an owned ledger lock", async () => {
    const { runtime, absolute, baseSha256 } = await fixture();
    const before = await readFile(absolute, "utf8");
    const held = await acquireLedgerLock(runtime.repositoryRoot);
    try {
      await expect(applyWrite(runtime, { file, baseSha256, author: story }, { lock: { timeoutMs: 100, pollMs: 10 } })).rejects.toBeInstanceOf(LockError);
      expect(await readFile(absolute, "utf8")).toBe(before);
    } finally {
      await held.release();
    }
    const results = await Promise.allSettled([
      applyWrite(runtime, { file, baseSha256, author: story }),
      applyWrite(runtime, { file, baseSha256, author: { ...story, id: "MGA-S03" } }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")[0]).toMatchObject({ reason: expect.any(ConflictError) });
  });

  it.each(["create.story", "create.task", "create.subtask", "toggle.subtask"] as const)
  ("restores original source bytes and removes atomic files when %s fails external validation", async (operation) => {
    const { runtime, root, absolute, baseSha256 } = await fixture(true);
    let currentSha = baseSha256;
    if (operation === "toggle.subtask") {
      const created = await applyWrite(runtime, { file, baseSha256, author: {
        operation: "create.subtask", taskId: "MGA-002", id: "MGA-002.1", title: "Already present",
      } });
      currentSha = created.sha256;
    }
    await writeFile(path.join(root, ".projects-board", "validate"), "#!/bin/sh\nprintf 'refused authoring' >&2\nexit 7\n", { mode: 0o755 });
    const other = path.join(root, "plans", "signal-harbor.md");
    const [before, otherBefore] = await Promise.all([readFile(absolute), readFile(other)]);
    const author = operation === "create.story" ? story
      : operation === "create.task" ? task
        : operation === "create.subtask" ? { operation, taskId: "MGA-002", id: "MGA-002.1", title: "Refused subtask" } as const
          : { operation, taskId: "MGA-002", id: "MGA-002.1" } as const;
    await expect(applyWrite(runtime, { file, baseSha256: currentSha, author })).rejects.toBeInstanceOf(ValidationError);
    expect(await readFile(absolute)).toEqual(before);
    expect(await readFile(other)).toEqual(otherBefore);
    expect((await readdir(path.dirname(absolute))).filter((entry) => entry.includes(".board-") && entry.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses CRLF authoring without changing any source bytes", async () => {
    const { runtime, absolute } = await fixture();
    const crlf = Buffer.from((await readFile(absolute, "utf8")).replaceAll("\n", "\r\n"));
    await writeFile(absolute, crlf);
    const board = await loadBoard(runtime);
    const baseSha256 = board.documents.find((entry) => entry.path === file)!.sha256;
    await expect(applyWrite(runtime, { file, baseSha256, author: story })).rejects.toBeInstanceOf(PatchError);
    expect(await readFile(absolute)).toEqual(crlf);
  });
});
