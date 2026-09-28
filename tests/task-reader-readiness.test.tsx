// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { handleApi } from "../server/api.ts";
import { loadBoard } from "../server/ledger/corpus.ts";
import type { Board } from "../server/ledger/model.ts";
import {
  createQwenReadinessManifest, dependencyFingerprint, packetFingerprint, serializeQwenReadinessManifest,
  taskFingerprint, type QwenReadinessEntry,
} from "../server/ledger/qwen-readiness.ts";
import { loadBoardRuntime } from "../server/runtime.ts";
import { boardSchema } from "../shared/contracts.ts";
import { TaskDrawer } from "../src/components/TaskDrawer.tsx";
import { disposableDemo, removeDisposableDemo } from "./fixture.ts";

vi.mock("../src/components/TaskActivity.tsx", () => ({ TaskActivity: ({ render }: {
  render?: (activity: React.JSX.Element) => React.JSX.Element | null;
}) => render ? render(<></>) : null }));

const checkedAt = "2026-09-08T12:00:00.000Z";
const commit = "a".repeat(40);
const hostile = "<img src=x onerror=alert(1)> `RDY-001` https://example.invalid";
const recordedBlockers = ["Awaiting the fictional telescope calibration record", hostile];
const PLAN = "plans/readiness-states.md";
const LABELS = ["Objective", "Why", "Scope", "Starting point", "Decisions already made", "Decision authority",
  "Contract", "Change required", "Invariants", "Non-goals", "Acceptance criteria", "Verify",
  "Escalate, do not assume, if", "Handoff"];
const TASKS = [
  ["RDY-001", "Qwen3-Coder-Next packet", "READY"],
  ["RDY-002", "Qwen3.8-Flash-Next packet", "READY"],
  ["RDY-003", "Qwen3.8-Flash-Next packet", "READY"],
  ["RDY-004", "Qwen3.8-Flash-Next packet", "READY"],
  ["RDY-005", "Qwen3.8-Flash-Next packet", "READY"],
  ["RDY-006", "Qwen3.8-Flash-Next packet", "BLOCKED_BY_SPEC"],
] as const;

function plan(): string {
  return ["# Readiness states", "",
    "| ID | Priority | Status | Dependencies | Repository | Required outcome |", "|---|---|---|---|---|---|",
    ...TASKS.map(([id]) => `| ${id} | P1 | Ready | None | orbit | Record the ${id} orbit. |`), "",
    "### RDY-S01 - Record readiness states", "- **Outcome:** record every readiness state",
    "- **So that:** observers agree", `- **Delivered by:** ${TASKS.map(([id]) => `\`${id}\``).join(", ")}`, "",
    ...TASKS.flatMap(([id, heading, status]) => [`### ${id} - Observe the ${id} orbit`, "", `#### ${heading}`, "",
      "- **Readiness:**", `  - Packet status: ${status}`, "  - Work kind: implementation",
      "  - Estimated changed LOC: production 250; tests 100; total 350",
      "  - File/symbol plan: orbit:src/orbit.ts | state: existing | symbols: observe | behavior: record orbit | write: observe only | proof: orbit tests",
      ...LABELS.map((label) => `- **${label}:** Bounded orbit evidence.`), ""]),
  ].join("\n");
}

type BoardResponse = ReturnType<typeof boardSchema.parse>;
const boards = {} as Record<"loaded" | "missing" | "invalid", BoardResponse>;
let root = "";

function manifest(base: Board): string {
  const byId = new Map(base.tasks.filter((task) => base.tasks.filter((other) => other.id === task.id).length === 1)
    .map((task) => [task.id, task]));
  const outcomes: Record<string, Partial<QwenReadinessEntry>> = {
    "RDY-001": {}, "RDY-002": { outcome: "BLOCKED_BY_SPEC", blockers: recordedBlockers },
    "RDY-003": { packetFingerprint: "d".repeat(64) }, "RDY-004": { outcome: "NO_CHANGE_NEEDED" },
  };
  const entries = Object.entries(outcomes).map(([id, change]): QwenReadinessEntry => {
    const task = base.tasks.find((candidate) => candidate.id === id)!;
    const detail = base.details.find((block) => block.file === task.file && block.id === id) ?? null;
    const metadata = task.packetMetadata;
    return { taskId: id, file: task.file, taskFingerprint: taskFingerprint(task), packetFingerprint: packetFingerprint(detail),
      dependencyFingerprint: dependencyFingerprint(task, byId), workKind: metadata.workKind!,
      estimatedChangedLoc: metadata.estimatedChangedLoc, sizeException: metadata.sizeException,
      splitTaskIds: metadata.splitTaskIds, files: metadata.files,
      repositories: [{ repository: "orbit", root: "/nonexistent/orbit", commit, ref: "dev", refCommit: commit, clean: true }],
      inputs: [], preflights: { repository: "pass", ref: "pass", inputs: "pass", worktree: "pass", collision: "pass" },
      checkedAt, revalidateWhen: ["source or repository changes"], outcome: "READY", blockers: [], ...change };
  });
  return serializeQwenReadinessManifest(createQwenReadinessManifest({ toolVersion: "fixture/1", auditBaseCommit: commit,
    planRevision: base.planRevision, capturedAt: checkedAt, candidateTaskIds: entries.map((entry) => entry.taskId), entries }));
}

async function served(runtime: Awaited<ReturnType<typeof loadBoardRuntime>>): Promise<BoardResponse> {
  const response = await handleApi(runtime, "GET", "/api/board", undefined);
  expect(response.status).toBe(200);
  return boardSchema.parse(response.body);
}

beforeAll(async () => {
  root = await disposableDemo();
  await writeFile(path.join(root, PLAN), plan());
  const runtime = await loadBoardRuntime({ repo: root });
  boards.missing = await served(runtime);
  const file = path.join(root, ".projects-board/qwen-readiness.json");
  await writeFile(file, "{");
  boards.invalid = await served(runtime);
  await writeFile(file, manifest(await loadBoard(runtime, checkedAt)));
  boards.loaded = await served(runtime);
}, 60_000);
afterAll(async () => { if (root) await removeDisposableDemo(root); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function open(board: BoardResponse, id: string, tab = "Evidence") {
  const task = board.tasks.find((candidate) => candidate.id === id)!;
  render(<TaskDrawer task={task} board={board} mode={{ kind: "viewer" }} onClose={vi.fn()} onSelectTask={vi.fn()}
    onOpenGraph={vi.fn()} sourceRef="refs/heads/main" sourceSha={commit} />);
  if (tab !== "Overview") fireEvent.click(screen.getByRole("tab", { name: tab }));
  return task;
}
const section = () => screen.getByRole("region", { name: "Readiness states" });
const states = () => within(section());
const blockerItems = () => within(states().getByRole("list", { name: "Dispatch blockers" }))
  .getAllByRole("listitem").map((node) => node.textContent);

describe("task reader readiness states", () => {
  it("loads the fictional corpus in all three manifest states", () => {
    expect(boards.missing.qwenReadiness.status).toBe("missing");
    expect(boards.invalid.qwenReadiness.status).toBe("invalid");
    expect(boards.loaded.qwenReadiness.status).toBe("loaded");
    const readiness = (id: string) => boards.loaded.tasks.find((task) => task.id === id)!;
    expect(TASKS.map(([id]) => readiness(id).executionReadiness))
      .toEqual(["ready", "blocked", "stale", "no-change", "unassessed", "unassessed"]);
    expect(TASKS.map(([id]) => readiness(id).qwen3CoderNextReady)).toEqual([true, true, true, true, true, false]);
  });

  it("lists a blocked packet's recorded blockers verbatim and never shows it as dispatch ready", () => {
    const task = open(boards.loaded, "RDY-002");
    expect(task.executionBlockers).toEqual(recordedBlockers);
    expect(states().getByText("Packet structure: READY")).toBeVisible();
    expect(states().getByText("Dispatch audit: blocked")).toBeVisible();
    expect(states().getByRole("heading", { name: "Dispatch blockers" })).toBeVisible();
    expect(blockerItems()).toEqual(recordedBlockers);
    expect(screen.queryByText("Dispatch audit: ready")).toBeNull();
  });

  it("shows a ready packet without a blockers list", () => {
    open(boards.loaded, "RDY-001");
    expect(states().getByText("Packet structure: READY")).toBeVisible();
    expect(states().getByText("Dispatch audit: ready")).toBeVisible();
    expect(states().queryByRole("heading", { name: "Dispatch blockers" })).toBeNull();
    expect(states().queryByRole("list")).toBeNull();
  });

  it.each([
    ["RDY-003", "Packet structure: READY", "Dispatch audit: stale", ["task packet changed after audit"]],
    ["RDY-004", "Packet structure: READY", "Dispatch audit: no change needed", []],
    ["RDY-005", "Packet structure: READY", "Dispatch audit: not audited", ["task is outside the audited startable set"]],
    ["RDY-006", "Packet structure: not READY", "Dispatch audit: not audited", ["task is outside the audited startable set"]],
  ] as const)("shows %s as %s and %s", (id, packet, audit, blockers) => {
    open(boards.loaded, id);
    expect(states().getByText(packet)).toBeVisible();
    expect(states().getByText(audit)).toBeVisible();
    if (blockers.length === 0) expect(states().queryByRole("heading", { name: "Dispatch blockers" })).toBeNull();
    else expect(blockerItems()).toEqual(blockers);
  });

  it.each(["missing", "invalid"] as const)("explains a %s manifest instead of inventing prerequisites", (status) => {
    for (const [id] of TASKS) {
      const task = open(boards[status], id);
      expect(task.executionReadiness).toBe("unassessed");
      expect(task.executionBlockers.length).toBeGreaterThan(0);
      expect(states().getByText(`Dispatch audit: unavailable - readiness manifest ${status}`)).toBeVisible();
      expect(states().queryByRole("heading", { name: "Dispatch blockers" })).toBeNull();
      expect(states().queryByRole("list")).toBeNull();
      for (const blocker of task.executionBlockers) expect(screen.queryByText(blocker)).toBeNull();
      expect(screen.queryByText(/^Dispatch audit: (ready|blocked|stale|no change needed|not audited)$/)).toBeNull();
      cleanup();
    }
  });

  it("prefixes the tracker tag and keeps dependency tags unchanged", () => {
    for (const [id, tag] of [["RDY-001", "startable now"], ["MGA-003", "needs gate check"], ["SHB-002", "waiting"]] as const) {
      const task = open(boards.loaded, id, "Overview");
      const header = within(screen.getByTestId("task-drawer-focus"));
      expect(header.getByText(`Tracker status: ${task.statusBase}`)).toBeVisible();
      expect(header.getByText(tag, { exact: true })).toBeVisible();
      expect(header.queryByText(task.statusBase!, { exact: true })).toBeNull();
      cleanup();
    }
    open(boards.loaded, "RDY-001", "Overview");
    expect(within(screen.getByTestId("task-drawer-focus")).getByText("Tracker status: Ready")).toBeVisible();
  });

  it("renders Readiness states first in Evidence and nowhere else", () => {
    open(boards.loaded, "RDY-002", "Overview");
    for (const name of ["Overview", "Implementation", "Dependencies"]) {
      fireEvent.click(screen.getByRole("tab", { name }));
      expect(screen.queryByRole("region", { name: "Readiness states" })).toBeNull();
    }
    fireEvent.click(screen.getByRole("tab", { name: "Evidence" }));
    const headings = within(screen.getByRole("tabpanel")).getAllByRole("heading").map((node) => node.textContent);
    expect(headings[0]).toBe("Readiness states");
    expect(headings.indexOf("Readiness")).toBeGreaterThan(headings.indexOf("Dispatch blockers"));
    expect(headings.indexOf("Share this task")).toBeGreaterThan(headings.indexOf("Readiness"));
  });

  it("keeps the legacy packet heading structurally READY", () => {
    const detail = boards.loaded.details.find((block) => block.id === "RDY-001")!;
    expect(JSON.stringify(detail)).toContain("Qwen3-Coder-Next packet");
    open(boards.missing, "RDY-001");
    expect(states().getByText("Packet structure: READY")).toBeVisible();
  });

  it("keeps hostile blocker text inert", () => {
    open(boards.loaded, "RDY-002");
    expect(section().querySelectorAll("a, button, img, script")).toHaveLength(0);
    expect(states().getByText(hostile, { exact: true }).textContent).toBe(hostile);
    expect(screen.queryByRole("button", { name: "RDY-001" })).toBeNull();
  });
});
