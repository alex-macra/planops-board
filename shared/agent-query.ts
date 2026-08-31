import { z } from "zod";

import type { Board, DataQualityIssue, Task } from "./contracts.ts";
import { compareText } from "./compare.ts";
import { dataQualityIssueKindSchema } from "./data-quality.ts";
import { readinessReasons } from "./readiness.ts";
import {
  STALE_DAYS,
  type StaleTaskSelection,
  type StartableTaskSelection,
} from "./task-selectors.ts";

export const agentQueryNameSchema = z.enum(["startable", "stale", "issues"]);
export type AgentQueryName = z.infer<typeof agentQueryNameSchema>;

const gitShaSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const stringListSchema = z.array(z.string()).readonly();

export const agentQuerySourceSchema = z.object({
  ref: z.string().min(1),
  sha: gitShaSchema,
  corpusRevision: sha256Schema,
}).strict().readonly();
export type AgentQuerySource = z.infer<typeof agentQuerySourceSchema>;

export const agentQueryDependencySchema = z.object({
  id: z.string(),
  gate: z.string().nullable(),
  resolved: z.boolean(),
  ambiguous: z.boolean(),
  duplicate: z.boolean(),
}).strict().readonly();
export type AgentQueryDependency = z.infer<typeof agentQueryDependencySchema>;

const agentQueryTaskShape = {
  id: z.string(),
  title: z.string().nullable(),
  outcome: z.string(),
  file: z.string(),
  line: z.number().int().positive(),
  documentSha256: sha256Schema,
  status: z.string(),
  statusBase: z.string().nullable(),
  priority: z.string().nullable(),
  readiness: z.enum(["startable", "waiting", "needs-gate-check"]).nullable(),
  readinessReasons: stringListSchema,
  dependencies: z.array(agentQueryDependencySchema).readonly(),
  project: z.string(),
  projects: stringListSchema,
  repositories: stringListSchema,
} as const;

export const agentQueryTaskSchema = z.object(agentQueryTaskShape).strict().readonly();
export type AgentQueryTask = z.infer<typeof agentQueryTaskSchema>;

export const agentQueryStartableItemSchema = z.object({
  ...agentQueryTaskShape,
  fanOut: z.number().int().nonnegative(),
}).strict().readonly();
export type AgentQueryStartableItem = z.infer<typeof agentQueryStartableItemSchema>;

export const agentQueryStaleItemSchema = z.object({
  ...agentQueryTaskShape,
  ageDays: z.number().int().min(STALE_DAYS),
}).strict().readonly();
export type AgentQueryStaleItem = z.infer<typeof agentQueryStaleItemSchema>;

export const agentQueryIssueSchema = z.object({
  kind: dataQualityIssueKindSchema,
  taskId: z.string(),
  file: z.string(),
  line: z.number().int().positive(),
  detail: z.string(),
}).strict().readonly();
export type AgentQueryIssue = z.infer<typeof agentQueryIssueSchema>;

export const agentQueryStartableDataSchema = z.object({
  total: z.number().int().nonnegative(),
  items: z.array(agentQueryStartableItemSchema).readonly(),
}).strict().readonly();
export type AgentQueryStartableData = z.infer<typeof agentQueryStartableDataSchema>;

export const agentQueryStaleDataSchema = z.object({
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  thresholdDays: z.literal(STALE_DAYS),
  total: z.number().int().nonnegative(),
  items: z.array(agentQueryStaleItemSchema).readonly(),
}).strict().readonly();
export type AgentQueryStaleData = z.infer<typeof agentQueryStaleDataSchema>;

export const agentQueryIssuesDataSchema = z.object({
  total: z.number().int().nonnegative(),
  items: z.array(agentQueryIssueSchema).readonly(),
}).strict().readonly();
export type AgentQueryIssuesData = z.infer<typeof agentQueryIssuesDataSchema>;

const successEnvelopeShape = {
  contractVersion: z.literal(1),
  ok: z.literal(true),
  source: agentQuerySourceSchema,
} as const;

export const agentQueryStartableSuccessSchema = z.object({
  ...successEnvelopeShape,
  command: z.literal("query.startable"),
  data: agentQueryStartableDataSchema,
}).strict().readonly();
export type AgentQueryStartableSuccess = z.infer<typeof agentQueryStartableSuccessSchema>;

export const agentQueryStaleSuccessSchema = z.object({
  ...successEnvelopeShape,
  command: z.literal("query.stale"),
  data: agentQueryStaleDataSchema,
}).strict().readonly();
export type AgentQueryStaleSuccess = z.infer<typeof agentQueryStaleSuccessSchema>;

export const agentQueryIssuesSuccessSchema = z.object({
  ...successEnvelopeShape,
  command: z.literal("query.issues"),
  data: agentQueryIssuesDataSchema,
}).strict().readonly();
export type AgentQueryIssuesSuccess = z.infer<typeof agentQueryIssuesSuccessSchema>;

export const agentQuerySuccessSchema = z.discriminatedUnion("command", [
  agentQueryStartableSuccessSchema,
  agentQueryStaleSuccessSchema,
  agentQueryIssuesSuccessSchema,
]);
export type AgentQuerySuccess = z.infer<typeof agentQuerySuccessSchema>;

export const agentQueryErrorCodeSchema = z.enum([
  "invalid_request",
  "missing_task",
  "conflict",
  "validation_failed",
  "forbidden",
  "internal_error",
]);
export type AgentQueryErrorCode = z.infer<typeof agentQueryErrorCodeSchema>;

export const agentQueryFailureSchema = z.object({
  contractVersion: z.literal(1),
  ok: z.literal(false),
  command: z.string().regex(/^query\.[a-z][a-z0-9-]*$/),
  error: z.object({
    code: agentQueryErrorCodeSchema,
    message: z.string().min(1),
    details: z.array(z.string()).readonly().optional(),
  }).strict().readonly(),
}).strict().readonly();
export type AgentQueryFailure = z.infer<typeof agentQueryFailureSchema>;

export const agentQueryEnvelopeSchema = z.union([
  agentQuerySuccessSchema,
  agentQueryFailureSchema,
]);
export type AgentQueryEnvelope = z.infer<typeof agentQueryEnvelopeSchema>;

export function sortDataQualityIssues(
  issues: readonly DataQualityIssue[],
): readonly DataQualityIssue[] {
  return [...issues].sort((left, right) =>
    compareText(left.kind, right.kind) ||
    compareText(left.file, right.file) ||
    left.line - right.line ||
    compareText(left.taskId, right.taskId) ||
    compareText(left.detail, right.detail),
  );
}

export function toAgentQueryTask(board: Board, task: Task): AgentQueryTask {
  const document = board.documents.find((candidate) => candidate.path === task.file);
  if (!document) throw new Error(`No document summary exists for ${task.file}`);
  return agentQueryTaskSchema.parse({
    id: task.id,
    title: task.title,
    outcome: task.outcome,
    file: task.file,
    line: task.line,
    documentSha256: document.sha256,
    status: task.status,
    statusBase: task.statusBase,
    priority: task.priority,
    readiness: task.readiness,
    readinessReasons: readinessReasons(board, task),
    dependencies: task.dependencies.map((dependency) => ({
      id: dependency.id,
      gate: dependency.gate,
      resolved: dependency.resolved,
      ambiguous: dependency.ambiguous,
      duplicate: dependency.duplicate,
    })),
    project: task.project,
    projects: task.projects,
    repositories: task.repositories,
  });
}

export function toAgentQueryStartableItem(
  board: Board,
  selection: StartableTaskSelection,
): AgentQueryStartableItem {
  return agentQueryStartableItemSchema.parse({
    ...toAgentQueryTask(board, selection.task),
    fanOut: selection.fanOut,
  });
}

export function toAgentQueryStaleItem(
  board: Board,
  selection: StaleTaskSelection,
): AgentQueryStaleItem {
  return agentQueryStaleItemSchema.parse({
    ...toAgentQueryTask(board, selection.task),
    ageDays: selection.ageDays,
  });
}
