import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractDetailBlocks } from "../server/ledger/detail.ts";
import { buildBoard, revisionOf, type Board, type SourceDocument } from "../server/ledger/model.ts";
import { loadBoard, planningDocuments, sha256 } from "../server/ledger/corpus.ts";
import { loadBoardRuntime } from "../server/runtime.ts";
import { toBoardResponse } from "../server/board-response.ts";
import { handleApi } from "../server/api.ts";
import { boardSchema } from "../shared/contracts.ts";
import { disposableDemo, removeDisposableDemo } from "./fixture.ts";
import {
  assessTaskExecution, createQwenReadinessManifest, dependencyFingerprint, packetFingerprint,
  taskFingerprint, taskPacketMetadata, type QwenReadinessEntry, type QwenReadinessSource,
  type QwenTaskSubject, type WorkKind, boardRevision, missingQwenReadinessSource, serializeQwenReadinessManifest,
} from "../server/ledger/qwen-readiness.ts";

const revision = "b".repeat(64), checkedAt = "2026-09-08T12:00:00.000Z";
const repository = { repository: "orbit", root: "/nonexistent/orbit", commit: "a".repeat(40),
  ref: "dev", refCommit: "a".repeat(40), clean: true };
const loc = (total: number) => ({ production: { min: total - 100, max: total - 100 },
  tests: { min: 100, max: 100 }, total: { min: total, max: total } });
function fixture(options: { kind?: WorkKind; total?: number; exception?: string; split?: readonly string[];
  extra?: string; omitFiles?: boolean; subject?: Partial<QwenTaskSubject>; entry?: Partial<QwenReadinessEntry> } = {}) {
  const kind = options.kind ?? "implementation", total = options.total ?? 350;
  const task: QwenTaskSubject = { id: "ORB-001", file: "plans/orbit.md", epic: "Orbit", section: "Ledger",
    title: "Observe the orbit", line: 10, writable: true, status: "Ready", statusBase: "Ready", statusQualifier: "",
    statusValid: true, priority: "P1", owners: ["orbit"], repositories: ["orbit"], project: "orbit", projects: ["orbit"],
    dependencies: [], dependencyResidue: [], outcome: "Record the orbit.", readiness: "startable",
    qwen3CoderNextReady: true, storyId: "ORB-S01", ...options.subject };
  const labels = ["Objective", "Why", "Scope", "Starting point", "Decisions already made", "Decision authority",
    "Contract", "Change required", "Invariants", "Non-goals", "Acceptance criteria", "Verify", "Escalate, do not assume, if", "Handoff"];
  const markdown = [`### ${task.id} - ${task.title}`, "", "#### Qwen3-Coder-Next packet", "", "- **Readiness:**",
    "  - Packet status: READY", `  - Work kind: ${kind}`,
    ...(kind === "implementation" ? [`  - Estimated changed LOC: production ${total - 100}; tests 100; total ${total}`] : []),
    ...(options.exception ? [`  - Size exception: ${options.exception}`] : []),
    ...(options.split?.length ? [`  - Split plan: ${options.split.map((id) => `\`${id}\``).join(", ")}`] : []),
    ...(options.omitFiles ? [] : ["  - File/symbol plan: orbit:src/orbit.ts | state: existing | symbols: observe | behavior: record orbit | write: observe only | proof: orbit tests"]),
    ...(options.extra ? [`  - ${options.extra}`] : []), ...labels.map((label) => `- **${label}:** Bounded orbit evidence.`)].join("\n");
  const details = extractDetailBlocks(markdown.split("\n"), task.file), byId = new Map([[task.id, task]]);
  const metadata = taskPacketMetadata(details[0]!);
  const entry: QwenReadinessEntry = { taskId: task.id, file: task.file, taskFingerprint: taskFingerprint(task),
    packetFingerprint: packetFingerprint(details[0]!), dependencyFingerprint: dependencyFingerprint(task, byId),
    workKind: kind, estimatedChangedLoc: metadata.estimatedChangedLoc, sizeException: metadata.sizeException,
    splitTaskIds: metadata.splitTaskIds, files: metadata.files, repositories: [repository], inputs: [],
    preflights: { repository: "pass", ref: "pass", inputs: "pass", worktree: "pass", collision: "pass" }, checkedAt,
    revalidateWhen: ["source or repository changes"], outcome: "READY", blockers: [], ...options.entry };
  const source: QwenReadinessSource = { status: "loaded", error: null, sha256: "c".repeat(64), manifest:
    createQwenReadinessManifest({ toolVersion: "fixture/1", auditBaseCommit: repository.commit, planRevision: revision,
      capturedAt: checkedAt, candidateTaskIds: [task.id], entries: [entry] }) };
  return { task, byId, details, source, entry, markdown };
}
const assess = (value: ReturnType<typeof fixture>, planRevision = revision) =>
  assessTaskExecution(value.task, value.byId, value.details, value.source, planRevision);
const blocked = (value: ReturnType<typeof fixture>, message: string) => {
  expect(assess(value).executionReadiness).toBe("blocked"); expect(assess(value).executionBlockers).toContain(message);
};

describe("pure execution assessment", () => {
  it.each(["implementation", "verification", "research-docs"] as const)("readies %s under its own kind", (kind) => {
    expect(assess(fixture({ kind }))).toEqual({ executionReadiness: "ready", workKind: kind,
      estimatedChangedLoc: kind === "implementation" ? loc(350) : null, sizeException: null,
      readinessCheckedAt: checkedAt, executionBlockers: [] });
  });
  it.each(["missing", "invalid", "outside"] as const)("leaves %s evidence unassessed", (state) => {
    const value = fixture();
    const result = state === "outside" ? assess({ ...value, task: { ...value.task, id: "ORB-999" } }) :
      assess({ ...value, source: { ...value.source, status: state, manifest: null, error: state === "invalid" ? "Malformed audit" : null } });
    expect(result).toMatchObject({ executionReadiness: "unassessed", workKind: null, readinessCheckedAt: null });
    expect(result.executionBlockers).toEqual([state === "invalid" ? "Malformed audit" : state === "outside"
      ? "task is outside the audited startable set" : "no audited readiness manifest entry"]);
  });
  it.each(["READY", "BLOCKED_BY_SPEC", "NO_CHANGE_NEEDED"] as const)("checks every stale predicate before %s", (outcome) => {
    const value = fixture({ entry: { outcome, file: "plans/other.md", taskFingerprint: "d".repeat(64),
      packetFingerprint: "e".repeat(64), dependencyFingerprint: "f".repeat(64) } });
    expect(assess(value).executionBlockers).toEqual(["task moved to another planning document", "task fields changed after audit",
      "task packet changed after audit", "task dependencies or prerequisite states changed after audit"]);
    expect(assess(value).executionReadiness).toBe("stale");
    expect(assess(value, "0".repeat(64))).toMatchObject({ executionReadiness: "stale",
      executionBlockers: ["planning corpus changed after the readiness audit"] });
  });
  it.each(["file", "taskFingerprint", "packetFingerprint", "dependencyFingerprint"] as const)("rejects isolated %s drift", (key) => {
    expect(assess(fixture({ entry: { [key]: key === "file" ? "plans/other.md" : "d".repeat(64) } })).executionReadiness).toBe("stale");
  });
  it.each(["missing", "duplicate", "foreign"])("cannot trust %s task details", (mode) => {
    const value = fixture(), detail = value.details[0]!;
    const details = mode === "missing" ? [] : mode === "duplicate" ? [detail, detail] : [{ ...detail, file: "plans/other.md" }];
    expect(assess({ ...value, details })).toMatchObject({ executionReadiness: "stale", executionBlockers: ["task packet changed after audit"] });
    blocked({ ...fixture({ entry: { packetFingerprint: packetFingerprint(null) } }), details }, "no same-file task detail block exists");
  });
  it.each([["BLOCKED_BY_SPEC", "blocked"], ["NO_CHANGE_NEEDED", "no-change"]] as const)("preserves matched %s before dispatch checks", (outcome, expected) => {
    const result = assess(fixture({ subject: { writable: false }, entry: { outcome, blockers: ["Recorded reason"] } }));
    expect(result).toMatchObject({ executionReadiness: expected, executionBlockers: ["Recorded reason"] });
  });
  it.each([{ writable: false }, { readiness: "waiting" }, { readiness: "needs-gate-check" }, { readiness: null },
    { storyId: null }, { qwen3CoderNextReady: false }] satisfies Partial<QwenTaskSubject>[])("blocks unusable subject %#", (subject) => {
    expect(assess(fixture({ subject })).executionReadiness).toBe("blocked");
  });
  it.each(["repository", "ref", "inputs", "worktree", "collision"] as const)("requires passing %s preflight", (key) => {
    for (const result of ["fail", "not-run"] as const) {
      const entry = fixture().entry;
      blocked(fixture({ entry: { preflights: { ...entry.preflights, [key]: result } } }), "one or more live preflights did not pass");
    }
  });
  it.each([
    [[], "no immutable repository evidence was recorded"], [[repository, repository], "repository evidence contains duplicate repository identities"],
    [[{ ...repository, clean: false }], "repository evidence records a dirty worktree"],
    [[{ ...repository, refCommit: "d".repeat(40) }], "repository HEAD and audited ref do not identify the same commit"],
    [[{ ...repository, repository: "other" }], "task-owned repository orbit has no immutable evidence"],
  ] as const)("rejects invalid repository evidence %#", (repositories, message) => blocked(fixture({ entry: { repositories } }), message));
  it.each(["owner-action", "external-hardware"] as const)("never readies %s", (kind) =>
    blocked(fixture({ kind }), `${kind} work is never agent-dispatchable`));
  it.each([
    [{ workKind: "verification" }, "packet Work kind does not match the manifest"],
    [{ sizeException: "One indivisible orbit seam." }, "packet size exception does not match the manifest"],
    [{ splitTaskIds: ["ORB-002"] }, "packet split plan does not match the manifest"],
    [{ estimatedChangedLoc: null }, "implementation work has no changed-LOC estimate"],
    [{ estimatedChangedLoc: loc(400) }, "packet LOC estimate does not match the manifest"],
    [{ files: [] }, "packet file/symbol plans do not match the manifest"],
  ] satisfies [Partial<QwenReadinessEntry>, string][])("blocks entry metadata disagreement %#", (entry, message) => blocked(fixture({ entry }), message));
  it("requires evidence for every file-plan repository", () => {
    const files = fixture().entry.files.map((file) => ({ ...file, repository: "other" }));
    blocked(fixture({ entry: { files } }), "file plan repository other has no immutable evidence");
  });
  it.each(["verification", "research-docs"] as const)("requires %s file plans and null LOC on both sides", (kind) => {
    blocked(fixture({ kind, omitFiles: true }), `${kind} packet must contain at least one File/symbol plan item`);
    blocked(fixture({ kind, entry: { estimatedChangedLoc: loc(350) } }), "non-implementation work must not carry a changed-LOC estimate");
    blocked(fixture({ kind, extra: "Estimated changed LOC: production 250; tests 100; total 350", entry: { estimatedChangedLoc: null } }),
      "non-implementation work must not carry a changed-LOC estimate");
  });
  it("retains source metadata problems despite a READY entry", () =>
    blocked(fixture({ extra: "Work kind: invalid" }), "packet must contain one valid Work kind item"));
  it.each([[250, undefined, "blocked"], [250, "None", "blocked"], [250, "One indivisible orbit seam.", "ready"],
    [300, undefined, "ready"], [400, undefined, "ready"]] as const)("applies LOC boundary %s with exception %s", (total, exception, expected) => {
    expect(assess(fixture({ total, ...(exception ? { exception } : {}) })).executionReadiness).toBe(expected);
  });
  it.each(["none", "unknown", "self", "file", "story", "unordered", "ordered"])("blocks oversized %s split", (mode) => {
    const split = mode === "none" ? [] : mode === "unknown" ? ["ORB-999"] : mode === "self" ? ["ORB-001"] : ["ORB-002", "ORB-003", "ORB-004"];
    const value = fixture({ total: 450, split });
    for (const [index, id] of ["ORB-002", "ORB-003", "ORB-004"].entries()) value.byId.set(id, { ...value.task, id,
      file: mode === "file" ? "plans/other.md" : value.task.file, storyId: mode === "story" ? "ORB-S02" : value.task.storyId,
      dependencies: index > 0 && mode !== "unordered" ? [{ id: `ORB-00${index + 1}`, gate: null, raw: `ORB-00${index + 1}`,
        resolved: true, ambiguous: false, duplicate: false }] : [] });
    const problems: Record<string, string> = { none: "oversized implementation has no bounded split plan", unknown: "split plan names an unknown child task",
      self: "split plan names the parent task as a child", file: "split-plan children must remain in the parent's epic and story",
      story: "split-plan children must remain in the parent's epic and story", unordered: "split-plan children are not dependency ordered" };
    const result = assess(value);
    expect(result.executionReadiness).toBe("blocked");
    expect(result.executionBlockers).toEqual(["oversized implementation is a replanning parent and cannot be dispatched", ...(problems[mode] ? [problems[mode]] : [])]);
  });
  it("deduplicates READY blockers in first-observed order", () => {
    expect(assess(fixture({ subject: { writable: false, storyId: null }, entry: { blockers:
      ["Recorded reason", "task comes from a read-only planning document", "Recorded reason"] } })).executionBlockers)
      .toEqual(["Recorded reason", "task comes from a read-only planning document", "task has no same-epic Story or Enabler"]);
  });
  it("preserves frozen subjects, details and manifest evidence without probing paths", () => {
    const value = fixture(), before = JSON.stringify([value, [...value.byId]]);
    const freeze = (item: unknown): void => { if (item !== null && typeof item === "object") {
      Object.values(item).forEach(freeze); Object.freeze(item);
    } };
    freeze(value); freeze([...value.byId.values()]);
    expect(assess(value)).toEqual(assess(value)); expect(assess(value).executionReadiness).toBe("ready");
    expect(JSON.stringify([value, [...value.byId]])).toBe(before);
  });
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(removeDisposableDemo)); });
function document(extra = "", writable = true): SourceDocument {
  const text = ["# Orbit", "", "| ID | Priority | Status | Dependencies | Repository | Required outcome |",
    "|---|---|---|---|---|---|", "| ORB-001 | P1 | Ready | None | orbit | Record the orbit. |", "",
    "### ORB-S01 - Record an orbit", "- **Outcome:** record an orbit", "- **So that:** observations agree",
    "- **Delivered by:** `ORB-001`", "", fixture().markdown.replace("  - Packet status: READY",
      `  - Packet status: READY${extra ? `\n  - ${extra}` : ""}`)].join("\n");
  return { path: "plans/orbit.md", text, sha256: sha256(text), writable };
}
const build = (input: SourceDocument, source = missingQwenReadinessSource(), repositories = ["orbit"]) =>
  buildBoard([input], new Set(repositories), [], checkedAt, undefined, source);
function audit(board: Board, changes: Partial<QwenReadinessEntry> = {}): QwenReadinessSource {
  const task = board.tasks.find((candidate) => candidate.id === "ORB-001")!;
  const byId = new Map(board.tasks.filter((candidate) => board.tasks.filter((other) => other.id === candidate.id).length === 1)
    .map((candidate) => [candidate.id, candidate]));
  const entry = { ...fixture().entry, file: task.file, taskFingerprint: taskFingerprint(task),
    packetFingerprint: packetFingerprint(board.details.find((block) => block.file === task.file && block.id === task.id) ?? null),
    dependencyFingerprint: dependencyFingerprint(task, byId), ...changes };
  const manifest = createQwenReadinessManifest({ toolVersion: "fixture/1", auditBaseCommit: repository.commit,
    planRevision: board.planRevision, capturedAt: checkedAt, candidateTaskIds: [task.id], entries: [entry] });
  return { status: "loaded", manifest, sha256: sha256(serializeQwenReadinessManifest(manifest)), error: null };
}
describe("Board readiness integration", () => {
  it.each(["ready", "blocked", "no-change", "stale", "unassessed"] as const)("transports %s with separate revision identities", (outcome) => {
    const input = document(), base = build(input);
    const source = outcome === "unassessed" ? missingQwenReadinessSource() : audit(base, {
      outcome: outcome === "blocked" ? "BLOCKED_BY_SPEC" : outcome === "no-change" ? "NO_CHANGE_NEEDED" : "READY",
      ...(outcome === "stale" ? { packetFingerprint: "d".repeat(64) } : {}) });
    const board = build(input, source), response = toBoardResponse(board);
    expect(response.tasks[0]).toEqual(board.tasks[0]); expect(response.tasks[0]?.executionReadiness).toBe(outcome);
    expect(response.planRevision).toBe(revisionOf([input]));
    expect(response.revision).toBe(boardRevision(response.planRevision, source));
    expect(board.planRevision).toBe(base.planRevision); expect(response.qwenReadiness.status).toBe(source.status);
  });
  it.each(["read-only", "unassigned", "waiting"])("does not promote a matched %s subject", (mode) => {
    const input = document("", mode !== "read-only");
    const text = mode === "unassigned" ? input.text.replace("- **Delivered by:** `ORB-001`", "") : mode === "waiting"
      ? input.text.replace("| None |", "| ORB-002 |").replace("| Record the orbit. |",
        "| Record the orbit. |\n| ORB-002 | P1 | Ready | None | orbit | Observe. |") : input.text;
    const current = { ...input, text, sha256: sha256(text) };
    const task = build(current, audit(build(current))).tasks[0]!;
    expect(task.executionReadiness).toBe("blocked");
    if (mode === "waiting") expect(task.readiness).toBe("waiting");
  });
  it.each([
    { name: "100000 characters", count: 0, length: 100_000, position: 0, omitted: 0, overlong: 0 },
    { name: "100001 characters", count: 0, length: 100_001, position: 0, omitted: 1, overlong: 1 },
    { name: "two overlong reasons", count: 0, length: 100_001, position: 0, omitted: 2, overlong: 2 },
    { name: "10000 reasons", count: 10_000, length: 0, position: 0, omitted: 0, overlong: 0 },
    { name: "10001 reasons", count: 10_001, length: 0, position: 0, omitted: 2, overlong: 0 },
    { name: "overlong first with a displaced reason", count: 10_000, length: 100_001, position: 0, omitted: 2, overlong: 1 },
    { name: "overlong middle with a displaced reason", count: 10_000, length: 100_001, position: 5_000, omitted: 2, overlong: 1 },
    { name: "overlong last with a displaced reason", count: 10_000, length: 100_001, position: 10_000, omitted: 2, overlong: 1 },
  ])("round-trips blocked diagnostics at $name", ({ count, length, position, omitted, overlong }) => {
    const reason = (name: string) => `task-owned repository ${name} has no immutable evidence`;
    const names = Array.from({ length: count }, (_, index) => `missing-${index}`);
    if (length) names.splice(position, 0, ...Array.from({ length: Math.max(1, overlong) },
      (_, index) => String(index).repeat(length - reason("").length)));
    const input = document(), text = input.text.replace("| orbit |", `| orbit; ${names.join("; ")} |`);
    const current = { ...input, text, sha256: sha256(text) }, known = ["orbit", ...names];
    const source = audit(build(current, undefined, known)), before = JSON.stringify([current, source]);
    const board = build(current, source, known), task = board.tasks[0]!;
    expect(task.repositories).toEqual(known); expect(task.executionReadiness).toBe("blocked");
    expect(task.readiness).toBe("startable"); expect(task.qwen3CoderNextReady).toBe(true);
    expect(boardSchema.parse(toBoardResponse(board)).tasks[0]).toEqual(task);
    const original = names.map(reason);
    const expected = omitted === 0 ? original : [
      ...original.filter((item) => item.length <= 100_000).slice(0, 9_999),
      `execution blocker overflow: omitted ${omitted} reasons (${overlong} overlong)`,
    ];
    expect(task.executionBlockers).toEqual(expected);
    expect(task.executionBlockers.length).toBeLessThanOrEqual(10_000);
    expect(task.executionBlockers.every((item) => item.length <= 100_000)).toBe(true);
    expect(build(current, source, known).tasks[0]?.executionBlockers).toEqual(expected);
    expect(JSON.stringify([current, source])).toBe(before);
  });
  it("keeps a normal audited implementation ready without overflow diagnostics", () => {
    const input = document(), source = audit(build(input));
    const board = build(input, source), task = boardSchema.parse(toBoardResponse(board)).tasks[0]!;
    expect(task.executionReadiness).toBe("ready"); expect(task.executionBlockers).toEqual([]);
    expect(task).toEqual(build(input, source).tasks[0]);
  });
  it("stales an audit after corpus-only changes while ignoring generated time", () => {
    const input = document(), source = audit(build(input)), text = `${input.text}\nAdditional orbit context.`;
    expect(build({ ...input, text, sha256: sha256(text) }, source).tasks[0]).toMatchObject({ executionReadiness: "stale",
      executionBlockers: ["planning corpus changed after the readiness audit"] });
    expect(buildBoard([input], new Set(["orbit"]), [], "2026-09-09T12:00:00.000Z", undefined, source).revision).toBe(build(input, source).revision);
  });
  it("never borrows an audited no-change disposition for duplicate identities", () => {
    const input = document(), text = input.text.replace("| ORB-001 | P1", "| ORB-001 | P1 | Ready | None | orbit | Duplicate. |\n| ORB-001 | P1");
    const current = { ...input, text, sha256: sha256(text) };
    const board = build(current, audit(build(current), { outcome: "NO_CHANGE_NEEDED" }));
    expect(board.tasks).toHaveLength(2);
    for (const task of board.tasks) expect(task).toMatchObject({ executionReadiness: "blocked", workKind: null, readinessCheckedAt: null });
  });
  it.each(["Split plan:", "Split plan: `invalid`", "Split plan: `ORB-002`,", "Split plan: `ORB-002`, `ORB-002`",
    "Split plan: `ORB-002`, `ORB-003`, `ORB-004`, `ORB-005`", `Split plan: ${Array<string>(5_000).fill("``").join(",")}`, "Size exception:"])
    ("round-trips malformed diagnostic metadata case %#", (extra) => {
      const input = document(extra), board = build(input, audit(build(input))), task = board.tasks[0]!;
      expect(task.packetMetadata.issues.length).toBeGreaterThan(0); expect(task.executionReadiness).toBe("blocked");
      expect(toBoardResponse(board).tasks[0]?.packetMetadata).toEqual(task.packetMetadata);
    });
  it("preserves missing-detail diagnostics and separates current metadata from audit values", () => {
    const input = document(), text = input.text.split("### ORB-001")[0]!;
    const missing = build({ ...input, text, sha256: sha256(text) });
    expect(toBoardResponse(missing).tasks[0]?.packetMetadata).toEqual(taskPacketMetadata(null));
    const changed = toBoardResponse(build(input, audit(build(input), { estimatedChangedLoc: loc(400) })));
    expect(changed.tasks[0]?.packetMetadata.estimatedChangedLoc).toEqual(loc(350));
    expect(changed.tasks[0]?.estimatedChangedLoc).toEqual(loc(400));
  });
  it.each([{ executionReadiness: "unsafe" }, { workKind: "shell" }, { estimatedChangedLoc: loc(-1) },
    { packetMetadata: { workKind: "shell" } }])("rejects malformed readiness transport case %#", (change) => {
    const response = toBoardResponse(build(document()));
    expect(boardSchema.safeParse({ ...response, tasks: [{ ...response.tasks[0], ...change }] }).success).toBe(false);
  });
  it.each([{ sizeException: "", issues: [] }, { sizeException: "x".repeat(100_001) }, { splitTaskIds: [42] },
    { files: Array(501).fill({}) }])("bounds malformed diagnostic values without treating them as valid metadata %#", (change) => {
    const response = toBoardResponse(build(document())), task = response.tasks[0]!;
    expect(boardSchema.safeParse({ ...response, tasks: [{ ...task, packetMetadata: { ...task.packetMetadata, ...change } }] }).success).toBe(false);
  });
  it.each(["v1", "v2", "v2-read-only"])("loads optional manifests using %s runtime scope without rewriting sources", async (version) => {
    const root = await disposableDemo(); roots.push(root);
    const input = document(); await writeFile(path.join(root, input.path), input.text);
    let runtime = await loadBoardRuntime({ repo: root });
    if (version !== "v1") {
      await writeFile(runtime.configPath, JSON.stringify({ ...runtime.config, version: 2,
        documents: { ...runtime.config.documents, writable: version === "v2" ? [input.path] : [] } }));
      runtime = await loadBoardRuntime({ repo: root });
    }
    const before = await planningDocuments(runtime), base = await loadBoard(runtime, checkedAt);
    expect(base.qwenReadiness.status).toBe("missing"); expect(base.tasks.every((task) => task.executionReadiness === "unassessed")).toBe(true);
    const file = path.join(root, ".projects-board/qwen-readiness.json");
    await writeFile(file, "{"); const invalid = await loadBoard(runtime, checkedAt);
    expect(invalid.qwenReadiness.status).toBe("invalid"); expect(invalid.planRevision).toBe(base.planRevision);
    expect(invalid.revision).not.toBe(base.revision); expect(invalid.tasks.every((task) => task.executionReadiness === "unassessed")).toBe(true);
    const source = audit(base), text = serializeQwenReadinessManifest(source.manifest!); await writeFile(file, text);
    const response = await handleApi(runtime, "GET", "/api/board", undefined), board = boardSchema.parse(response.body);
    expect(response.status).toBe(200); expect(board.tasks.find((task) => task.id === "ORB-001")?.executionReadiness)
      .toBe(version === "v2-read-only" ? "blocked" : "ready");
    expect(board.planRevision).toBe(base.planRevision); expect(board.revision).not.toBe(invalid.revision);
    for (const task of board.tasks) if (!task.writable) {
      expect(task).toMatchObject({ writable: false, readiness: null, statusCell: null, priorityCell: null, outcomeCell: null });
    }
    expect(await planningDocuments(runtime)).toEqual(before); expect(await readFile(file, "utf8")).toBe(text);
  });
});
