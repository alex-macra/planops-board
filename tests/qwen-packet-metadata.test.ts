import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { extractDetailBlocks } from "../server/ledger/detail.ts";
import {
  boardRevision, dependencyFingerprint, missingQwenReadinessSource, packetFingerprint,
  taskFingerprint, taskPacketMetadata, type QwenTaskSubject, type WorkKind,
} from "../server/ledger/qwen-readiness.ts";

const labels = ["Objective", "Why", "Scope", "Starting point", "Decisions already made", "Decision authority",
  "Contract", "Change required", "Invariants", "Non-goals", "Acceptance criteria", "Verify", "Escalate, do not assume, if", "Handoff"];
const loc = "  - Estimated changed LOC: production 250; tests 100; total 350";
const filePlan = "  - File/symbol plan: orbit:src/orbit.ts | state: existing | symbols: observe | behavior: record the orbit | write: observe only | proof: orbit fixture";
function packet(kind: WorkKind = "implementation") {
  return ["### ORB-001 - Observe the orbit", "", "#### Qwen3-Coder-Next packet", "", "- **Readiness:**",
    "  - Packet status: READY", `  - Work kind: ${kind}`, ...(kind === "implementation" ? [loc] : []),
    ...(["implementation", "verification", "research-docs"].includes(kind) ? [filePlan] : []),
    ...labels.map((label) => `- **${label}:** Bounded orbit evidence.`)].join("\n");
}
const block = (markdown = packet()) => extractDetailBlocks(markdown.split("\n"), "plans/orbit.md")[0]!;
function subject(): QwenTaskSubject {
  return { id: "ORB-001", file: "plans/orbit.md", epic: "Orbit", section: "Ledger", title: "Observe the orbit",
    line: 10, writable: true, status: "Ready", statusBase: "Ready", statusQualifier: "", statusValid: true,
    priority: "P1", owners: ["orbit"], repositories: ["orbit"], project: "orbit", projects: ["orbit"],
    dependencies: [], dependencyResidue: [], outcome: "Record the orbit.", readiness: "startable",
    qwen3CoderNextReady: true, storyId: "ORB-S01" };
}

describe("packet compatibility fingerprints", () => {
  it("matches the task, packet, empty-dependency and missing-source golden hashes", () => {
    const task = subject();
    expect(taskFingerprint(task)).toBe("33a365a13461f65649aca2bd6ef03cb697188dc600bc5a62a25f7f6ded90a5fa");
    expect(packetFingerprint(block())).toBe("1ddcec29b3ffa80ab9053fd003563d7d54db76839139fc90d71b45bc1fa9b70d");
    expect(packetFingerprint(null)).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(dependencyFingerprint(task, new Map([[task.id, task]]))).toBe("ef2dbf58677a8ec776069f052278967b32797827d5f336fbf751ed52e998329c");
    expect(boardRevision("b".repeat(64), missingQwenReadinessSource())).toBe("c2fb2f9b680b1e6d000420afcb51282f1f16c0e9c4557f57300fcbe52ff1b727");
  });

  it.each([{ writable: false }, { storyId: "ORB-S02" }, { line: 11 }, { status: "In progress" }, { outcome: "Observe the moon." }])
    ("binds changed task fields %#", (change) => {
      expect(taskFingerprint({ ...subject(), ...change })).not.toBe(taskFingerprint(subject()));
    });

  it("binds resolved prerequisite state without following repository paths", () => {
    const target = { ...subject(), id: "ORB-000", status: "Complete", statusBase: "Complete" };
    const task = { ...subject(), dependencies: [{ id: target.id, gate: null, raw: target.id, resolved: true, ambiguous: false, duplicate: false }] };
    const ready = dependencyFingerprint(task, new Map([[target.id, target]]));
    expect(ready).toBe("4e6995b59a52875c44e2d789ae1baef0fa97d0dfef24064bdb0b3759a8b4e49b");
    expect(dependencyFingerprint(task, new Map([[target.id, { ...target, status: "Ready", statusBase: "Ready" }]]))).not.toBe(ready);
    expect(dependencyFingerprint(task, new Map())).not.toBe(ready);
  });

  it("fingerprints packet fields while leaving unrelated evidence outside the range", () => {
    expect(packetFingerprint(block(`${packet()}\n- **Evidence:** Earlier orbit observation.`))).toBe(packetFingerprint(block()));
    expect(packetFingerprint(block(packet().replace("total 350", "total 351")))).not.toBe(packetFingerprint(block()));
  });

  it("binds dependency residue and source status or bytes into their revisions", () => {
    const task = subject();
    expect(dependencyFingerprint({ ...task, dependencyResidue: ["unresolved orbit gate"] }, new Map()))
      .not.toBe(dependencyFingerprint(task, new Map()));
    const source = missingQwenReadinessSource();
    const revision = boardRevision("b".repeat(64), source);
    expect(boardRevision("c".repeat(64), source)).not.toBe(revision);
    expect(boardRevision("b".repeat(64), { ...source, status: "invalid" })).not.toBe(revision);
    expect(boardRevision("b".repeat(64), { ...source, sha256: "d".repeat(64) })).not.toBe(revision);
  });
});

describe("structured packet metadata", () => {
  it("extracts implementation evidence and defers sizing policy to assessment", () => {
    const metadata = taskPacketMetadata(block());
    expect(metadata).toEqual({ workKind: "implementation", estimatedChangedLoc: {
      production: { min: 250, max: 250 }, tests: { min: 100, max: 100 }, total: { min: 350, max: 350 },
    }, sizeException: null, splitTaskIds: [], files: [{ repository: "orbit", path: "src/orbit.ts", state: "existing",
      symbols: ["observe"], behavior: "record the orbit", writeBoundary: "observe only", proof: "orbit fixture" }], issues: [] });
    expect(taskPacketMetadata(block(packet().replace(loc, "  - Estimated changed LOC: production 300-350; tests 100-150; total 400-500"))).issues).toEqual([]);
  });

  it.each(["verification", "research-docs", "owner-action", "external-hardware"] as const)("recognizes %s without inventing LOC", (kind) => {
    expect(taskPacketMetadata(block(packet(kind)))).toMatchObject({ workKind: kind, estimatedChangedLoc: null, issues: [] });
  });

  it("reads a sizing exception and a bounded split list", () => {
    const metadata = taskPacketMetadata(block(packet().replace(loc, `${loc}\n  - Size exception: One indivisible parser seam.\n  - Split plan: \`ORB-002\`, \`ORB-003\``)));
    expect(metadata).toMatchObject({ sizeException: "One indivisible parser seam.", splitTaskIds: ["ORB-002", "ORB-003"], issues: [] });
  });

  it.each([
    ["missing kind", "  - Work kind: implementation", ""],
    ["unknown kind", "Work kind: implementation", "Work kind: shell"],
    ["duplicate kind", "Work kind: implementation", "Work kind: implementation\n  - Work kind: implementation"],
    ["missing LOC", loc, ""], ["incorrect total", "total 350", "total 351"],
    ["inverted range", "production 250; tests 100; total 350", "production 250-200; tests 100; total 350-300"],
    ["unbounded number", "production 250; tests 100; total 350", "production 999999999999999999; tests 100; total 999999999999999999"],
    ["malformed LOC", loc, "  - Estimated changed LOC: many lines"],
    ["duplicate LOC", loc, `${loc}\n${loc}`],
    ["duplicate exception", loc, `${loc}\n  - Size exception: First reason.\n  - Size exception: Second reason.`],
    ["empty exception", loc, `${loc}\n  - Size exception:`],
    ["empty split", loc, `${loc}\n  - Split plan:`],
    ["malformed split", loc, `${loc}\n  - Split plan: not-a-task`],
    ["duplicate split", loc, `${loc}\n  - Split plan: \`ORB-002\`, \`ORB-002\``],
    ["oversized split", loc, `${loc}\n  - Split plan: \`ORB-002\`, \`ORB-003\`, \`ORB-004\`, \`ORB-005\``],
    ["repeated split field", loc, `${loc}\n  - Split plan: \`ORB-002\`\n  - Split plan: \`ORB-003\``],
    ["malformed file plan", filePlan, "  - File/symbol plan: unknown"],
    ["missing symbols", "symbols: observe", "symbols: "],
    ["empty proof", "proof: orbit fixture", "proof: "],
    ["unsafe path", "orbit:src/orbit.ts", "orbit:../orbit.ts"],
    ["missing file plan", filePlan, ""],
  ])("reports %s as an issue without throwing", (_name, from, to) => {
    expect(taskPacketMetadata(block(packet().replace(from!, to!))).issues.length).toBeGreaterThan(0);
  });

  it("fails closed on missing, incomplete and duplicate packet ranges", () => {
    expect(taskPacketMetadata(null)).toMatchObject({ workKind: null, estimatedChangedLoc: null, files: [] });
    expect(taskPacketMetadata(null).issues.length).toBeGreaterThan(0);
    expect(taskPacketMetadata(block(packet().replace("- **Handoff:** Bounded orbit evidence.", ""))).issues.length).toBeGreaterThan(0);
    const range = packet().slice(packet().indexOf("- **Readiness:**"));
    expect(taskPacketMetadata(block(`${packet()}\n${range}`)).issues.length).toBeGreaterThan(0);
  });

  it("accepts three unique split IDs without imposing the assessment size policy", () => {
    const detail = block(packet().replace(loc, `${loc}\n  - Split plan: \`ORB-002\`, \`ORB-003\`, \`ORB-004\``));
    expect(taskPacketMetadata(detail)).toMatchObject({ splitTaskIds: ["ORB-002", "ORB-003", "ORB-004"], issues: [] });
  });

  it.each(["`ORB-002`, `invalid`, `ORB-003`", "`ORB-002` ignored `ORB-003`", "`ORB-002`, ORB-003", "`ORB-002`,", "`ORB-002`,, `ORB-003`"])
    ("rejects malformed split residue %s", (split) => {
      expect(taskPacketMetadata(block(packet().replace(loc, `${loc}\n  - Split plan: ${split}`))).issues)
        .toContain("Split plan must name at most three unique dependency-ordered task IDs");
    });

  it("preserves delimiter-like text in valid file-plan proof and path values", () => {
    const markdown = packet().replace("orbit:src/orbit.ts", "orbit:src/orbit:next.ts")
      .replace("state: existing", "STATE: EXISTING").replace("proof: orbit fixture", "proof: orbit | fixture: passes");
    expect(taskPacketMetadata(block(markdown))).toMatchObject({ files: [{ repository: "orbit", path: "src/orbit:next.ts",
      state: "existing", proof: "orbit | fixture: passes" }], issues: [] });
  });

  it("rejects many near-limit delimiter attacks without blocking for seconds", () => {
    const detail = block();
    const hostile = { ...detail, fields: detail.fields.map((field, index) => index === 0 ? { ...field,
      items: [...field.items, ...Array<string>(32).fill(`File/symbol plan: ${":".repeat(32_768)}`),
        `File/symbol plan: ${"bad:|nope".repeat(8_000)}`,
        `File/symbol plan: ${"orbit:src|state: invalid|symbols: a|behavior: a|write: a|proof: a|".repeat(1_000)}`] } : field) };
    const start = performance.now();
    expect(taskPacketMetadata(hostile).issues).toHaveLength(34);
    expect(performance.now() - start).toBeLessThan(5_000);
  });

  it.each([
    ["item count", Array<string>(2_001).fill("Bounded item."), "too many metadata items"],
    ["single item", ["x".repeat(100_001)], "metadata is too large"],
    ["aggregate bytes", Array<string>(100).fill("x".repeat(90_000)), "metadata is too large"],
    ["file plans", Array<string>(501).fill(filePlan.trim().slice(2)), "too many File/symbol plans"],
  ])("bounds %s before returning usable metadata", (_name, items, issue) => {
    const detail = block();
    const oversized = { ...detail, fields: detail.fields.map((field, index) =>
      index === 0 ? { ...field, items: [...field.items, ...items] } : field) };
    expect(taskPacketMetadata(oversized)).toMatchObject({ workKind: null, estimatedChangedLoc: null,
      files: [], splitTaskIds: [], issues: [expect.stringContaining(issue)] });
  });

  it("is deterministic for frozen detail inputs", async () => {
    const detail = block(); const before = JSON.stringify(detail);
    for (const field of detail.fields) { Object.freeze(field.items); Object.freeze(field); }
    Object.freeze(detail.fields); Object.freeze(detail);
    const results = await Promise.all([0, 1, 2].map(async () => taskPacketMetadata(detail)));
    expect(results).toEqual(Array(3).fill(results[0]));
    expect(JSON.stringify(detail)).toBe(before);
  });
});
