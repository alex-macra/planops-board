import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadBoard } from "../server/ledger/corpus.ts";
import { validateBoardRuntime } from "../server/ledger/validate.ts";
import { loadBoardRuntime } from "../server/runtime.ts";
import { handleApi } from "../server/api.ts";
import { boardSchema } from "../shared/contracts.ts";
import { disposableDemo, removeDisposableDemo } from "./fixture.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeDisposableDemo));
});

async function demoBoard() {
  const root = await disposableDemo();
  roots.push(root);
  const runtime = await loadBoardRuntime({ repo: root });
  await validateBoardRuntime(runtime);
  return loadBoard(runtime, "2026-08-20T12:00:00.000Z");
}

describe("fictional demo board", () => {
  it("passes the bundled structural validator", async () => {
    const board = await demoBoard();
    expect(board.documents.map((document) => document.path)).toEqual([
      "plans/moon-garden.md",
      "plans/shared-observatory.md",
      "plans/signal-harbor.md",
    ]);
    expect(board.tasks).toHaveLength(9);
  });

  it("serves a board that conforms to the shared transport contract", async () => {
    const root = await disposableDemo();
    roots.push(root);
    const runtime = await loadBoardRuntime({ repo: root });
    const response = await handleApi(runtime, "GET", "/api/board", undefined);
    const parsed = boardSchema.safeParse(response.body);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.documents[0]?.vocabulary).not.toHaveProperty("meanings");
  });

  it("keeps a status qualifier separate from its configured base", async () => {
    const task = (await demoBoard()).tasks.find((entry) => entry.id === "MGA-001");
    expect(task).toMatchObject({
      status: "Complete; field notes pending",
      statusBase: "Complete",
      statusQualifier: "field notes pending",
      readiness: null,
    });
  });

  it("derives waiting and unchecked-gate readiness from configured semantics", async () => {
    const board = await demoBoard();
    expect(board.tasks.find((task) => task.id === "MGA-002")?.readiness).toBe("startable");
    expect(board.tasks.find((task) => task.id === "MGA-003")?.readiness).toBe(
      "needs-gate-check",
    );
    expect(board.tasks.find((task) => task.id === "SHB-002")?.readiness).toBe("waiting");
  });

  it("keeps a document-local status visible but outside the configured workflow", async () => {
    const board = await demoBoard();
    const task = board.tasks.find((entry) => entry.id === "SOV-003");
    expect(task).toMatchObject({
      statusBase: "Exploring",
      statusValid: true,
      readiness: "needs-gate-check",
    });
    expect(board.statusBases).toContain("Exploring");
  });

  it("keeps unknown-priority issues inside the browser contract", async () => {
    const root = await disposableDemo();
    roots.push(root);
    const file = path.join(root, "plans", "moon-garden.md");
    const text = await readFile(file, "utf8");
    await writeFile(file, text.replace("| `MGA-002` | P1 |", "| `MGA-002` | PX |"));
    const runtime = await loadBoardRuntime({ repo: root });
    const response = await handleApi(runtime, "GET", "/api/board", undefined);
    const parsed = boardSchema.safeParse(response.body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.issues).toContainEqual(expect.objectContaining({
        kind: "unknown-priority",
        taskId: "MGA-002",
      }));
    }
  });

  it("attributes a multi-product owner as cross-cutting", async () => {
    const task = (await demoBoard()).tasks.find((entry) => entry.id === "SOV-002");
    expect(task?.project).toBe("cross-cutting");
    expect(task?.projects).toEqual(["moon-garden", "signal-harbor"]);
  });

  it("parses stories, enablers, details, and dated notes", async () => {
    const board = await demoBoard();
    expect(board.stories.map((story) => [story.id, story.kind])).toEqual([
      ["MGA-S01", "story"],
      ["SOV-S01", "enabler"],
      ["SHB-S01", "story"],
    ]);
    const detail = board.details.find((entry) => entry.id === "MGA-002");
    expect(detail?.fields.find((field) => field.label === "Note")?.date).toBe("2026-08-20");
  });
});
