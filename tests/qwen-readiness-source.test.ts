import { createHash } from "node:crypto";
import { mkdir, readFile, rename, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createQwenReadinessManifest, loadQwenReadinessSource, manifestFingerprint,
  missingQwenReadinessSource, parseQwenReadinessManifest, qwenReadinessSummary,
  QWEN_READINESS_PATH, serializeQwenReadinessManifest,
} from "../server/ledger/qwen-readiness.ts";
import { disposableDemo, removeDisposableDemo } from "./fixture.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(removeDisposableDemo)); });
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const empty = () => createQwenReadinessManifest({
  toolVersion: "fixture/1", auditBaseCommit: "a".repeat(40), planRevision: "b".repeat(64),
  capturedAt: "2026-09-08T12:00:00.000Z", candidateTaskIds: [], entries: [],
});
const entry = () => ({
  taskId: "ORB-001", file: "plans/orbit.md", taskFingerprint: "c".repeat(64),
  packetFingerprint: "d".repeat(64), dependencyFingerprint: "e".repeat(64),
  workKind: "implementation" as const,
  estimatedChangedLoc: { production: { min: 250, max: 250 }, tests: { min: 100, max: 100 }, total: { min: 350, max: 350 } },
  sizeException: null, splitTaskIds: [],
  files: [{ repository: "orbit", path: "src/orbit.ts", state: "existing" as const,
    symbols: ["observe"], behavior: "Record the orbit", writeBoundary: "Only observe", proof: "Run orbit tests" }],
  repositories: [{ repository: "orbit", root: "/tmp/orbit", commit: "a".repeat(40), ref: "main", refCommit: "a".repeat(40), clean: true }],
  inputs: [{ path: "/tmp/orbit/src/orbit.ts", type: "file" as const, bytes: 10, sha256: "f".repeat(64) }],
  preflights: { repository: "pass" as const, ref: "pass" as const, inputs: "pass" as const, worktree: "pass" as const, collision: "pass" as const },
  checkedAt: "2026-09-08T12:00:00.000Z", revalidateWhen: ["source changes"], outcome: "READY" as const, blockers: [],
});
async function fixture(text?: string) {
  const root = await disposableDemo(); roots.push(root);
  const file = path.join(root, QWEN_READINESS_PATH);
  if (text !== undefined) await writeFile(file, text);
  return { root, file };
}

describe("readiness manifest source", () => {
  it("matches the version-one producer golden vector", () => {
    const manifest = empty();
    expect(manifest.manifestFingerprint).toBe("962565efeb905bad3d34bc29f7c1dd9ef3f4492329cf9fb8ea91973589c37990");
    expect(parseQwenReadinessManifest(serializeQwenReadinessManifest(manifest))).toEqual(manifest);
    expect(Object.isFrozen(manifest)).toBe(true);
  });

  it("loads complete immutable evidence repeatedly without mutating bytes", async () => {
    const { manifestFingerprint: _fingerprint, ...body } = empty();
    const manifest = createQwenReadinessManifest({ ...body, candidateTaskIds: ["ORB-001"], entries: [entry()] });
    const text = serializeQwenReadinessManifest(manifest);
    const { root, file } = await fixture(text);
    const sources = await Promise.all([loadQwenReadinessSource(root), loadQwenReadinessSource(root), loadQwenReadinessSource(root)]);
    expect(sources).toEqual(Array(3).fill({ status: "loaded", sha256: digest(text), manifest, error: null }));
    expect(Object.isFrozen(sources[0]?.manifest?.entries[0]?.files[0])).toBe(true);
    expect(qwenReadinessSummary(sources[0]!)).toMatchObject({ status: "loaded", candidateCount: 1, manifestSha256: digest(text) });
    expect(await readFile(file, "utf8")).toBe(text);
  });

  it("returns missing for an absent optional manifest", async () => {
    const { root } = await fixture();
    expect(await loadQwenReadinessSource(root)).toEqual(missingQwenReadinessSource());
  });

  it.each(["{", JSON.stringify({ ...empty(), schemaVersion: 2 }), JSON.stringify({ ...empty(), extra: true }),
    JSON.stringify({ ...empty(), manifestFingerprint: "0".repeat(64) })])("fails closed on invalid manifest bytes", async (text) => {
    const { root, file } = await fixture(text);
    const source = await loadQwenReadinessSource(root);
    expect(source).toMatchObject({ status: "invalid", manifest: null, sha256: digest(text) });
    expect(source.error!.length).toBeLessThanOrEqual(500);
    expect(await readFile(file, "utf8")).toBe(text);
  });

  it.each([
    { taskId: "bad" }, { workKind: "shell" }, { checkedAt: "2026-09-08" }, { surprise: true },
    { splitTaskIds: ["ORB-002", "ORB-002"] }, { splitTaskIds: ["ORB-002", "ORB-003", "ORB-004", "ORB-005"] },
    { inputs: [{ path: "/tmp/orbit", type: "file", bytes: null, sha256: null }] },
    { estimatedChangedLoc: { production: { min: 250, max: 200 }, tests: { min: 100, max: 100 }, total: { min: 350, max: 300 } } },
    { estimatedChangedLoc: { production: { min: 250, max: 250 }, tests: { min: 100, max: 100 }, total: { min: 351, max: 351 } } },
    { files: [{ ...entry().files[0], path: "../orbit.ts" }] }, { files: Array(501).fill(entry().files[0]) },
  ])("rejects invalid nested evidence case %# before fingerprint validation", (change) => {
    const body = { ...empty(), candidateTaskIds: ["ORB-001"], entries: [{ ...entry(), ...change }] };
    expect(() => parseQwenReadinessManifest(JSON.stringify(body))).toThrow(/shape is invalid/);
  });

  it("rejects repeated candidates even with a matching fingerprint", () => {
    const { manifestFingerprint: _fingerprint, ...original } = empty();
    const body = { ...original, candidateTaskIds: ["ORB-001", "ORB-001"], entries: [entry(), entry()] };
    expect(() => parseQwenReadinessManifest(JSON.stringify({ ...body, manifestFingerprint: manifestFingerprint(body) }))).toThrow();
  });

  it.each(["candidateTaskIds", "entries"])("rejects oversized %s before examining invalid elements", (key) => {
    const body = { ...empty(), [key]: Array(50_000).fill(null) };
    expect(() => parseQwenReadinessManifest(JSON.stringify(body)))
      .toThrow(`${key}: must be an array with at most 2000 items`);
  });

  it.each([
    ["splitTaskIds", 3], ["files", 500], ["repositories", 100],
    ["inputs", 500], ["revalidateWhen", 200], ["blockers", 500],
  ] as const)("rejects oversized nested %s before examining invalid elements", (key, limit) => {
    const body = { ...empty(), candidateTaskIds: ["ORB-001"], entries: [{ ...entry(), [key]: Array(limit + 1).fill(null) }] };
    expect(() => parseQwenReadinessManifest(JSON.stringify(body)))
      .toThrow(`entries.0.${key}: must be an array with at most ${limit} items`);
  });

  it("rejects oversized symbol arrays before examining invalid elements", () => {
    const oversized = { ...entry(), files: [{ ...entry().files[0], symbols: Array(201).fill(null) }] };
    expect(() => parseQwenReadinessManifest(JSON.stringify({ ...empty(), candidateTaskIds: ["ORB-001"], entries: [oversized] })))
      .toThrow("entries.0.files.0.symbols: must be an array with at most 200 items");
  });

  it("rejects reordered entries even with a matching fingerprint", () => {
    const { manifestFingerprint: _fingerprint, ...original } = empty();
    const body = { ...original, candidateTaskIds: ["ORB-001", "ORB-002"], entries: [{ ...entry(), taskId: "ORB-002" }, entry()] };
    expect(() => parseQwenReadinessManifest(JSON.stringify({ ...body, manifestFingerprint: manifestFingerprint(body) })))
      .toThrow(/entries must match/);
  });

  it("rejects invalid UTF-8 without rewriting input", async () => {
    const { root, file } = await fixture();
    const bytes = Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x30, 0x7d]);
    await writeFile(file, bytes);
    expect(await loadQwenReadinessSource(root)).toMatchObject({ status: "invalid", error: "manifest is not valid UTF-8" });
    expect(await readFile(file)).toEqual(bytes);
  });

  it.each(["file-link", "parent-link", "directory", "oversized"])("rejects unsafe file identity %s", async (kind) => {
    const { root, file } = await fixture(serializeQwenReadinessManifest(empty()));
    if (kind === "parent-link") {
      await rename(path.dirname(file), path.join(root, "evidence"));
      await symlink("evidence", path.dirname(file));
    } else if (kind === "file-link") {
      await rename(file, `${file}.real`); await symlink(`${path.basename(file)}.real`, file);
    } else if (kind === "directory") {
      await rename(file, `${file}.real`); await mkdir(file);
    } else await truncate(file, 8 * 1024 * 1024 + 1);
    expect(await loadQwenReadinessSource(root)).toMatchObject({ status: "invalid", manifest: null });
  });
});
