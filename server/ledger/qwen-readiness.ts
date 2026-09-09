import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assertSafeRepositoryFile } from "../runtime.ts";
import { taskPacketFieldRange, type DetailBlock } from "./detail.ts";
import type { Task } from "./model.ts";

export const QWEN_READINESS_SCHEMA_VERSION = 1;
export const QWEN_READINESS_PATH = ".projects-board/qwen-readiness.json";
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const text = (limit = 100_000) => z.string().min(1).max(limit);
const integer = z.number().int().min(0).max(10_000_000);
const sha256 = text(64).regex(/^[0-9a-f]{64}$/);
const commit = text(40).regex(/^[0-9a-f]{40}$/);
const taskId = text(10_000).regex(/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/);
const boundedArray = <T extends z.ZodType>(element: T, limit: number) =>
  z.custom<unknown[]>((value) => Array.isArray(value) && value.length <= limit,
    `must be an array with at most ${limit} items`).pipe(z.array(element)).readonly();
const strings = (limit = 2_000) => boundedArray(text(10_000), limit);
const uniqueIds = (limit = 2_000) => boundedArray(taskId, limit)
  .refine((ids) => new Set(ids).size === ids.length, "task IDs must be unique").readonly();
const timestamp = text(100).refine((value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}, "timestamp must be canonical ISO");
const workKindSchema = z.enum(["implementation", "verification", "research-docs", "owner-action", "external-hardware"]);
const outcomeSchema = z.enum(["READY", "BLOCKED_BY_SPEC", "NO_CHANGE_NEEDED"]);
const preflightSchema = z.enum(["pass", "fail", "not-run"]);
const locRangeSchema = z.strictObject({ min: integer, max: integer })
  .refine((range) => range.max >= range.min, "LOC maximum must be at least its minimum").readonly();
const estimatedLocSchema = z.strictObject({
  production: locRangeSchema, tests: locRangeSchema, total: locRangeSchema,
}).refine((loc) => loc.total.min === loc.production.min + loc.tests.min &&
  loc.total.max === loc.production.max + loc.tests.max, "LOC total must equal production plus tests").readonly();
const filePlanSchema = z.strictObject({
  repository: text(500),
  path: text(2_000).refine((value) => value !== "." && value !== ".." && !path.isAbsolute(value) &&
    !value.includes("\\") && !value.includes("\0") && path.posix.normalize(value) === value &&
    !value.startsWith("../"), "file plan path must be canonical and repository-relative"),
  state: z.enum(["existing", "new"]), symbols: boundedArray(text(10_000), 200)
    .refine((symbols) => symbols.length > 0, "symbols cannot be empty"),
  behavior: text(), writeBoundary: text(), proof: text(),
}).readonly();
const repositoryEvidenceSchema = z.strictObject({
  repository: text(500), root: text(2_000).refine(path.isAbsolute), commit,
  ref: text(1_000), refCommit: commit, clean: z.boolean(),
}).readonly();
const inputEvidenceSchema = z.strictObject({
  path: text(2_000).refine(path.isAbsolute), type: z.enum(["file", "directory"]),
  bytes: integer, sha256,
}).readonly();
const preflightsSchema = z.strictObject({
  repository: preflightSchema, ref: preflightSchema, inputs: preflightSchema,
  worktree: preflightSchema, collision: preflightSchema,
}).readonly();
const entrySchema = z.strictObject({
  taskId: taskId.max(96), file: text(1_000), taskFingerprint: sha256,
  packetFingerprint: sha256, dependencyFingerprint: sha256, workKind: workKindSchema,
  estimatedChangedLoc: estimatedLocSchema.nullable(), sizeException: text().nullable(),
  splitTaskIds: uniqueIds(3), files: boundedArray(filePlanSchema, 500),
  repositories: boundedArray(repositoryEvidenceSchema, 100),
  inputs: boundedArray(inputEvidenceSchema, 500), preflights: preflightsSchema,
  checkedAt: timestamp, revalidateWhen: strings(200), outcome: outcomeSchema, blockers: strings(500),
}).readonly();
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(QWEN_READINESS_SCHEMA_VERSION), toolVersion: text(200),
  auditBaseCommit: commit, planRevision: sha256, capturedAt: timestamp,
  candidateTaskIds: uniqueIds(), entries: boundedArray(entrySchema, 2_000),
  manifestFingerprint: sha256,
}).refine((manifest) => manifest.entries.map((entry) => entry.taskId).join("\0") ===
  manifest.candidateTaskIds.join("\0"), "entries must match candidate task IDs in order").readonly();

export type WorkKind = z.infer<typeof workKindSchema>;
export type AuditOutcome = z.infer<typeof outcomeSchema>;
export type PreflightResult = z.infer<typeof preflightSchema>;
export type LocRange = z.infer<typeof locRangeSchema>;
export type EstimatedChangedLoc = z.infer<typeof estimatedLocSchema>;
export type FileSymbolPlan = z.infer<typeof filePlanSchema>;
export type RepositoryEvidence = z.infer<typeof repositoryEvidenceSchema>;
export type InputEvidence = z.infer<typeof inputEvidenceSchema>;
export type ReadinessPreflights = z.infer<typeof preflightsSchema>;
export type QwenReadinessEntry = z.infer<typeof entrySchema>;
export type QwenReadinessManifest = z.infer<typeof manifestSchema>;

export interface QwenReadinessSource {
  readonly status: "missing" | "invalid" | "loaded";
  readonly sha256: string | null;
  readonly manifest: QwenReadinessManifest | null;
  readonly error: string | null;
}

export class QwenReadinessError extends Error {
  override readonly name = "QwenReadinessError";
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

export function manifestFingerprint(value: Omit<QwenReadinessManifest, "manifestFingerprint">): string {
  return digest(canonical(value));
}

export function createQwenReadinessManifest(
  value: Omit<QwenReadinessManifest, "schemaVersion" | "manifestFingerprint">,
): QwenReadinessManifest {
  const body: Omit<QwenReadinessManifest, "manifestFingerprint"> = {
    ...value, schemaVersion: QWEN_READINESS_SCHEMA_VERSION,
  };
  return parseQwenReadinessManifest(JSON.stringify({ ...body, manifestFingerprint: manifestFingerprint(body) }));
}

export function serializeQwenReadinessManifest(manifest: QwenReadinessManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function parseQwenReadinessManifest(text: string): QwenReadinessManifest {
  if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) {
    throw new QwenReadinessError("Qwen readiness manifest is too large");
  }
  let input: unknown;
  try { input = JSON.parse(text); }
  catch { throw new QwenReadinessError("Qwen readiness manifest is not valid JSON"); }
  const result = manifestSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new QwenReadinessError(`Manifest shape is invalid: ${issue?.path.join(".")}: ${issue?.message}`.slice(0, 500));
  }
  const { manifestFingerprint: fingerprint, ...body } = result.data;
  if (manifestFingerprint(body) !== fingerprint) {
    throw new QwenReadinessError("Qwen readiness manifest fingerprint does not match its content");
  }
  return result.data;
}

export function missingQwenReadinessSource(): QwenReadinessSource {
  return Object.freeze({ status: "missing", sha256: null, manifest: null, error: null });
}

export async function loadQwenReadinessSource(root: string): Promise<QwenReadinessSource> {
  let sha256: string | null = null;
  try {
    const canonicalRoot = await realpath(root);
    const absolute = await assertSafeRepositoryFile(canonicalRoot, QWEN_READINESS_PATH);
    const before = await lstat(absolute);
    if (before.size > MAX_MANIFEST_BYTES) throw new QwenReadinessError("manifest is too large");
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let text: string;
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.dev !== before.dev || metadata.ino !== before.ino ||
        metadata.size !== before.size || await realpath(absolute) !== absolute) {
        throw new QwenReadinessError("manifest file identity changed while opening");
      }
      const bytes = Buffer.alloc(metadata.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, length);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      const after = await handle.stat();
      if (length !== metadata.size || after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs) {
        throw new QwenReadinessError("manifest bytes changed while reading");
      }
      const content = bytes.subarray(0, length);
      if (!isUtf8(content)) throw new QwenReadinessError("manifest is not valid UTF-8");
      text = content.toString("utf8");
    } finally { await handle.close(); }
    sha256 = digest(text);
    return Object.freeze({ status: "loaded", sha256, manifest: parseQwenReadinessManifest(text), error: null });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return missingQwenReadinessSource();
    }
    return Object.freeze({ status: "invalid", sha256, manifest: null,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
  }
}

export function qwenReadinessSummary(source: QwenReadinessSource) {
  return Object.freeze({
    status: source.status, schemaVersion: source.manifest?.schemaVersion ?? null,
    auditBaseCommit: source.manifest?.auditBaseCommit ?? null, capturedAt: source.manifest?.capturedAt ?? null,
    candidateCount: source.manifest?.candidateTaskIds.length ?? 0, manifestSha256: source.sha256, error: source.error,
  });
}

export type QwenReadinessSummary = ReturnType<typeof qwenReadinessSummary>;

export type QwenTaskSubject = Pick<Task,
  "id" | "file" | "epic" | "section" | "title" | "line" | "status" | "statusBase" |
  "statusQualifier" | "statusValid" | "priority" | "owners" | "repositories" | "project" |
  "projects" | "dependencies" | "dependencyResidue" | "outcome" | "readiness"
> & { readonly writable: boolean; readonly qwen3CoderNextReady: boolean; readonly storyId: string | null };

export interface TaskPacketMetadata {
  readonly workKind: WorkKind | null;
  readonly estimatedChangedLoc: EstimatedChangedLoc | null;
  readonly sizeException: string | null;
  readonly splitTaskIds: readonly string[];
  readonly files: readonly FileSymbolPlan[];
  readonly issues: readonly string[];
}

export type ExecutionReadiness = "unassessed" | "ready" | "blocked" | "no-change" | "stale";

export interface TaskExecutionAssessment {
  readonly executionReadiness: ExecutionReadiness;
  readonly workKind: WorkKind | null;
  readonly estimatedChangedLoc: EstimatedChangedLoc | null;
  readonly sizeException: string | null;
  readonly readinessCheckedAt: string | null;
  readonly executionBlockers: readonly string[];
}

export function boardRevision(planRevision: string, source: QwenReadinessSource): string {
  return digest(`${planRevision}\0qwen-readiness\0${source.status}\0${source.sha256 ?? ""}`);
}

export function taskFingerprint(task: QwenTaskSubject): string {
  return digest(canonical({
    id: task.id, file: task.file, epic: task.epic, section: task.section, title: task.title,
    line: task.line, writable: task.writable, status: task.status, statusBase: task.statusBase,
    statusQualifier: task.statusQualifier, statusValid: task.statusValid, priority: task.priority,
    owners: task.owners, repositories: task.repositories, project: task.project,
    projects: task.projects, outcome: task.outcome, storyId: task.storyId,
  }));
}

export function packetFingerprint(block: DetailBlock | null): string {
  if (!block) return digest("");
  const range = taskPacketFieldRange(block.fields);
  return digest(canonical({
    marker: block.prose.filter((item) => /Qwen/i.test(item)),
    fields: range ? block.fields.slice(range.start, range.end + 1) : [],
  }));
}

export function dependencyFingerprint(task: QwenTaskSubject, byId: ReadonlyMap<string, QwenTaskSubject>): string {
  return digest(canonical({
    taskId: task.id,
    dependencies: task.dependencies.map((dependency) => ({
      ...dependency, targetStatus: byId.get(dependency.id)?.status ?? null,
      targetStatusBase: byId.get(dependency.id)?.statusBase ?? null,
      targetStatusValid: byId.get(dependency.id)?.statusValid ?? null,
    })),
    residue: task.dependencyResidue,
  }));
}

const LOC_RE = /^Estimated changed LOC:\s*production\s+(\d+)(?:-(\d+))?;\s*tests\s+(\d+)(?:-(\d+))?;\s*total\s+(\d+)(?:-(\d+))?$/i;
function parseFilePlan(item: string): FileSymbolPlan | null {
  const body = item.slice(item.indexOf(":") + 1).trim();
  const labels = ["state:", "symbols:", "behavior:", "write:", "proof:"];
  for (let separator = body.indexOf(":", 1); separator >= 0;) {
    const firstPipe = body.indexOf("|", separator + 1);
    if (firstPipe < 0) return null;
    const parts: string[] = [];
    let cursor = separator + 1;
    for (let index = 0; index < 5; index += 1) {
      const end = body.indexOf("|", cursor);
      if (end < 0) return null;
      parts.push(body.slice(cursor, end).trim());
      cursor = end + 1;
    }
    while (cursor < body.length && /\s/.test(body[cursor]!)) cursor += 1;
    if (firstPipe !== separator + 1 &&
      labels.slice(0, 4).every((label, index) => parts[index + 1]!.toLowerCase().startsWith(label)) &&
      body.slice(cursor, cursor + labels[4]!.length).toLowerCase() === labels[4] &&
      ["existing", "new"].includes(parts[1]!.slice(labels[0]!.length).trim().toLowerCase())) {
      parts.push(body.slice(cursor).trim());
      const values = labels.map((label, index) => parts[index + 1]!.slice(label.length).trim());
      const parsed = filePlanSchema.safeParse({
        repository: body.slice(0, separator).trim(), path: parts[0], state: values[0]!.toLowerCase(),
        symbols: values[1]!.split(",").map((symbol) => symbol.trim()).filter(Boolean),
        behavior: values[2], writeBoundary: values[3], proof: values[4],
      });
      return parsed.success ? parsed.data : null;
    }
    separator = body.indexOf(":", firstPipe + 1);
  }
  return null;
}

function emptyMetadata(issue: string): TaskPacketMetadata {
  return Object.freeze({ workKind: null, estimatedChangedLoc: null, sizeException: null,
    splitTaskIds: Object.freeze([]), files: Object.freeze([]), issues: Object.freeze([issue]) });
}

export function taskPacketMetadata(block: DetailBlock | null): TaskPacketMetadata {
  if (!block) return emptyMetadata("no same-file task detail block exists");
  const range = taskPacketFieldRange(block.fields);
  if (!range) return emptyMetadata("the ordered 15-field packet is incomplete");
  if (taskPacketFieldRange(block.fields.slice(range.end + 1))) {
    return emptyMetadata("task detail contains multiple complete packet ranges");
  }
  const fields = block.fields.slice(range.start, range.end + 1);
  let itemCount = 0;
  let bytes = 0;
  for (const field of fields) {
    itemCount += field.items.length;
    if (itemCount > 2_000) return emptyMetadata("packet contains too many metadata items");
    for (const item of field.items) {
      bytes += Buffer.byteLength(item, "utf8");
      if (item.length > 100_000 || bytes > MAX_MANIFEST_BYTES) return emptyMetadata("packet metadata is too large");
    }
  }
  const items = fields.flatMap((field) => field.items);
  const prefixed = (prefix: string) => items.filter((item) => item.toLowerCase().startsWith(prefix.toLowerCase()));
  const value = (item: string) => item.slice(item.indexOf(":") + 1).trim();
  const issues: string[] = [];
  const workItems = prefixed("Work kind:");
  const parsedKind = workKindSchema.safeParse(workItems.length === 1 ? value(workItems[0]!).toLowerCase() : null);
  const workKind = parsedKind.success ? parsedKind.data : null;
  if (!parsedKind.success) issues.push("packet must contain one valid Work kind item");

  const locItems = prefixed("Estimated changed LOC:");
  let estimatedChangedLoc: EstimatedChangedLoc | null = null;
  if (locItems.length === 1) {
    const match = locItems[0]!.match(LOC_RE);
    if (match) {
      const parsed = estimatedLocSchema.safeParse({
        production: { min: Number(match[1]), max: Number(match[2] ?? match[1]) },
        tests: { min: Number(match[3]), max: Number(match[4] ?? match[3]) },
        total: { min: Number(match[5]), max: Number(match[6] ?? match[5]) },
      });
      if (parsed.success) estimatedChangedLoc = parsed.data;
      else issues.push(`invalid packet LOC: ${parsed.error.issues[0]?.message}`);
    } else issues.push("Estimated changed LOC does not match the PlanOps grammar");
  } else if (locItems.length > 1 || workKind === "implementation") {
    issues.push("implementation packet must contain one Estimated changed LOC item");
  }

  const exceptionItems = prefixed("Size exception:");
  const sizeException = exceptionItems.length === 1 ? value(exceptionItems[0]!) : null;
  if (exceptionItems.length > 1) issues.push("packet repeats Size exception");
  if (sizeException === "") issues.push("Size exception cannot be empty");
  const splitItems = prefixed("Split plan:");
  const splitTokens = splitItems.flatMap((item) => value(item).split(/,|->/).map((token) => token.trim()));
  const splitTaskIds = splitTokens.map((token) => token.slice(1, -1));
  if (splitItems.length > 1 || !uniqueIds(3).safeParse(splitTaskIds).success ||
    splitTokens.some((token) => !token.startsWith("`") || !token.endsWith("`"))) {
    issues.push("Split plan must name at most three unique dependency-ordered task IDs");
  }

  const fileItems = prefixed("File/symbol plan:");
  if (fileItems.length > 500) return emptyMetadata("packet contains too many File/symbol plans");
  const files: FileSymbolPlan[] = [];
  for (const item of fileItems) {
    const parsed = parseFilePlan(item);
    if (parsed) files.push(parsed);
    else issues.push(`invalid File/symbol plan: ${item.slice(0, 300)}`);
  }
  if (["implementation", "verification", "research-docs"].includes(workKind ?? "") && files.length === 0) {
    issues.push(`${workKind} packet must contain at least one File/symbol plan item`);
  }
  return Object.freeze({ workKind, estimatedChangedLoc, sizeException,
    splitTaskIds: Object.freeze(splitTaskIds), files: Object.freeze(files), issues: Object.freeze(issues) });
}

function substantiveSizeException(value: string | null): boolean {
  if (!value || value.trim().length < 20) return false;
  return !/^(?:n\/?a|none|not applicable|tbd|unknown)[.!]?$/i.test(value.trim());
}

function splitPlanProblems(
  task: QwenTaskSubject,
  splitTaskIds: readonly string[],
  byId: ReadonlyMap<string, QwenTaskSubject>,
): string[] {
  if (splitTaskIds.length === 0) return ["oversized implementation has no bounded split plan"];
  if (splitTaskIds.includes(task.id)) return ["split plan names the parent task as a child"];
  const children = splitTaskIds.map((id) => byId.get(id) ?? null);
  if (children.some((child) => child === null)) return ["split plan names an unknown child task"];
  if (children.some((child) => child!.file !== task.file || child!.storyId !== task.storyId)) {
    return ["split-plan children must remain in the parent's epic and story"];
  }
  for (let index = 1; index < children.length; index += 1) {
    if (!children[index]!.dependencies.some((dependency) => dependency.id === children[index - 1]!.id)) {
      return ["split-plan children are not dependency ordered"];
    }
  }
  return [];
}

function assessment(
  executionReadiness: ExecutionReadiness,
  entry: QwenReadinessEntry | null,
  blockers: readonly string[],
): TaskExecutionAssessment {
  const maxBlockers = 10_000, maxLength = 100_000;
  const overlong = blockers.reduce((count, reason) => count + Number(reason.length > maxLength), 0);
  const overflow = blockers.length > maxBlockers || overlong > 0;
  const executionBlockers = overflow ? [] : [...blockers];
  if (overflow) {
    for (const reason of blockers) {
      if (reason.length <= maxLength && executionBlockers.length < maxBlockers - 1) executionBlockers.push(reason);
    }
    executionBlockers.push(`execution blocker overflow: omitted ${blockers.length - executionBlockers.length} reasons (${overlong} overlong)`);
  }
  return Object.freeze({
    executionReadiness,
    workKind: entry?.workKind ?? null,
    estimatedChangedLoc: entry?.estimatedChangedLoc ?? null,
    sizeException: entry?.sizeException ?? null,
    readinessCheckedAt: entry?.checkedAt ?? null,
    executionBlockers: Object.freeze(executionBlockers),
  });
}

export function assessTaskExecution(
  task: QwenTaskSubject,
  byId: ReadonlyMap<string, QwenTaskSubject>,
  details: readonly DetailBlock[],
  source: QwenReadinessSource,
  planRevision?: string,
): TaskExecutionAssessment {
  const manifest = source.manifest;
  if (source.status !== "loaded" || !manifest) {
    return assessment("unassessed", null, source.error ? [source.error] : ["no audited readiness manifest entry"]);
  }
  const entry = manifest.entries.find((candidate) => candidate.taskId === task.id) ?? null;
  if (!entry) return assessment("unassessed", null, ["task is outside the audited startable set"]);
  if (planRevision && manifest.planRevision !== planRevision) {
    return assessment("stale", entry, ["planning corpus changed after the readiness audit"]);
  }
  const matching = details.filter((detail) => detail.file === task.file && detail.id === task.id);
  const block = matching.length === 1 ? matching[0]! : null;
  const stale: string[] = [];
  if (entry.file !== task.file) stale.push("task moved to another planning document");
  if (entry.taskFingerprint !== taskFingerprint(task)) stale.push("task fields changed after audit");
  if (entry.packetFingerprint !== packetFingerprint(block)) stale.push("task packet changed after audit");
  if (entry.dependencyFingerprint !== dependencyFingerprint(task, byId)) {
    stale.push("task dependencies or prerequisite states changed after audit");
  }
  if (stale.length > 0) return assessment("stale", entry, stale);
  if (entry.outcome === "NO_CHANGE_NEEDED") return assessment("no-change", entry, entry.blockers);
  if (entry.outcome === "BLOCKED_BY_SPEC") return assessment("blocked", entry, entry.blockers);

  const blockers = [...entry.blockers];
  if (!task.writable) blockers.push("task comes from a read-only planning document");
  if (task.readiness !== "startable") blockers.push("task is not startable from its task dependencies");
  if (!task.storyId) blockers.push("task has no same-epic Story or Enabler");
  if (!task.qwen3CoderNextReady) blockers.push("packet is not structurally READY");
  if (!Object.values(entry.preflights).every((result) => result === "pass")) {
    blockers.push("one or more live preflights did not pass");
  }
  if (entry.repositories.length === 0) blockers.push("no immutable repository evidence was recorded");
  const evidenceNames = entry.repositories.map((repository) => repository.repository);
  if (new Set(evidenceNames).size !== evidenceNames.length) {
    blockers.push("repository evidence contains duplicate repository identities");
  }
  if (entry.repositories.some((repository) => !repository.clean)) {
    blockers.push("repository evidence records a dirty worktree");
  }
  if (entry.repositories.some((repository) => repository.commit !== repository.refCommit)) {
    blockers.push("repository HEAD and audited ref do not identify the same commit");
  }
  for (const repository of task.repositories) {
    if (!evidenceNames.includes(repository)) {
      blockers.push(`task-owned repository ${repository} has no immutable evidence`);
    }
  }
  if (entry.workKind === "owner-action" || entry.workKind === "external-hardware") {
    blockers.push(`${entry.workKind} work is never agent-dispatchable`);
  }

  const metadata = taskPacketMetadata(block);
  if (metadata.workKind !== entry.workKind) blockers.push("packet Work kind does not match the manifest");
  if (metadata.sizeException !== entry.sizeException) blockers.push("packet size exception does not match the manifest");
  if (canonical(metadata.splitTaskIds) !== canonical(entry.splitTaskIds)) {
    blockers.push("packet split plan does not match the manifest");
  }
  blockers.push(...metadata.issues);
  if (["implementation", "verification", "research-docs"].includes(entry.workKind)) {
    if (entry.files.length === 0 || canonical(metadata.files) !== canonical(entry.files)) {
      blockers.push("packet file/symbol plans do not match the manifest");
    }
    for (const plan of entry.files) {
      if (!evidenceNames.includes(plan.repository)) {
        blockers.push(`file plan repository ${plan.repository} has no immutable evidence`);
      }
    }
  }
  if (entry.workKind === "implementation") {
    const loc = entry.estimatedChangedLoc;
    if (!loc) blockers.push("implementation work has no changed-LOC estimate");
    else {
      if (canonical(metadata.estimatedChangedLoc) !== canonical(loc)) {
        blockers.push("packet LOC estimate does not match the manifest");
      }
      if (loc.total.max > 400) {
        blockers.push("oversized implementation is a replanning parent and cannot be dispatched");
        blockers.push(...splitPlanProblems(task, entry.splitTaskIds, byId));
      }
      if (loc.total.min < 300 && !substantiveSizeException(entry.sizeException)) {
        blockers.push("sub-300 LOC task has no substantive size exception");
      }
    }
  } else if (entry.estimatedChangedLoc !== null || metadata.estimatedChangedLoc !== null) {
    blockers.push("non-implementation work must not carry a changed-LOC estimate");
  }
  return blockers.length === 0
    ? assessment("ready", entry, [])
    : assessment("blocked", entry, [...new Set(blockers)]);
}
