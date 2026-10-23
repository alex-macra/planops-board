import { readFile, writeFile } from "node:fs/promises";
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
    const create = { operation: "create.subtask" as const, taskId: "MGA-002", id: "MGA-002.1", title: "Add [x] keyboard comparison", owner: "alex" };
    const created = await applyWrite(runtime, { file, baseSha256, author: create });
    const beforeToggle = await readFile(absolute, "utf8");
    expect((await loadBoard(runtime)).tasks.find((entry) => entry.id === create.taskId)?.subtasks).toMatchObject([
      { id: create.id, title: create.title, owner: "alex", done: false },
    ]);
    await applyWrite(runtime, { file, baseSha256: created.sha256, author: { operation: "toggle.subtask", taskId: create.taskId, id: create.id } });
    const after = await readFile(absolute, "utf8");
    expect(after).toBe(beforeToggle.replace("  - [ ] MGA-002.1", "  - [x] MGA-002.1"));
    expect((await loadBoard(runtime)).tasks.find((entry) => entry.id === create.taskId)?.subtasks[0]?.done).toBe(true);
  });

  it("refuses stale digests, duplicate IDs, invalid table and cross-file story before mutation", async () => {
    const { runtime, absolute, baseSha256 } = await fixture();
    const before = await readFile(absolute, "utf8");
    await expect(applyWrite(runtime, { file, baseSha256: "a".repeat(64), author: story })).rejects.toBeInstanceOf(ConflictError);
    await expect(applyWrite(runtime, { file, baseSha256, author: { ...story, id: "MGA-S01" } })).rejects.toBeInstanceOf(PatchError);
    await expect(applyWrite(runtime, { file, baseSha256, author: { ...task, id: "MGA-001" } })).rejects.toBeInstanceOf(PatchError);
    await expect(applyWrite(runtime, { file, baseSha256, author: { ...task, tableHeaderLine: 9 } })).rejects.toBeInstanceOf(PatchError);
    await expect(applyWrite(runtime, { file, baseSha256, author: { ...task, storyId: "SHR-S01" } })).rejects.toBeInstanceOf(PatchError);
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

  it("rolls authoring back byte-for-byte after an external validator refusal", async () => {
    const { runtime, root, absolute, baseSha256 } = await fixture(true);
    await writeFile(path.join(root, ".projects-board", "validate"), "#!/bin/sh\nprintf 'refused authoring' >&2\nexit 7\n", { mode: 0o755 });
    const before = await readFile(absolute, "utf8");
    await expect(applyWrite(runtime, { file, baseSha256, author: story })).rejects.toBeInstanceOf(ValidationError);
    expect(await readFile(absolute, "utf8")).toBe(before);
  });
});
