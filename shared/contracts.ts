import { z } from "zod";

import { dataQualityIssueKindSchema } from "./data-quality.ts";

const stringList = z.array(z.string()).readonly();

const workflowSchema = z.object({
  statusOrder: stringList,
  activeStatuses: stringList,
  blockedStatuses: stringList,
  closedStatuses: stringList,
  dependencySatisfiedStatuses: stringList,
  priorityOrder: stringList,
}).readonly();

export type Workflow = z.infer<typeof workflowSchema>;

const cellRefSchema = z.object({
  file: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().nonnegative(),
}).readonly();

const dependencySchema = z.object({
  id: z.string(),
  gate: z.string().nullable(),
  raw: z.string(),
  resolved: z.boolean(),
  ambiguous: z.boolean(),
  duplicate: z.boolean(),
}).readonly();

const readinessSchema = z.enum(["startable", "waiting", "needs-gate-check"]).nullable();

const taskSchema = z.object({
  id: z.string(),
  file: z.string(),
  epic: z.string(),
  section: z.string().nullable(),
  title: z.string().nullable(),
  line: z.number().int().positive(),
  status: z.string(),
  statusBase: z.string().nullable(),
  statusQualifier: z.string(),
  statusValid: z.boolean(),
  priority: z.string().nullable(),
  owners: stringList,
  repositories: stringList,
  project: z.string(),
  projects: stringList,
  dependencies: z.array(dependencySchema).readonly(),
  dependencyResidue: stringList,
  outcome: z.string(),
  raw: z.record(z.string(), z.string()).readonly(),
  statusCell: cellRefSchema.nullable(),
  priorityCell: cellRefSchema.nullable(),
  outcomeCell: cellRefSchema.nullable(),
  readiness: readinessSchema,
}).readonly();

const detailFieldSchema = z.object({
  label: z.string(),
  rawLabel: z.string(),
  date: z.string().nullable(),
  items: stringList,
}).readonly();

const detailLinkSchema = z.object({ label: z.string(), href: z.string() }).readonly();

const detailBlockSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  file: z.string(),
  headingLine: z.number().int().positive(),
  headingLevel: z.number().int().positive(),
  endLine: z.number().int().positive(),
  fields: z.array(detailFieldSchema).readonly(),
  prose: stringList,
  references: stringList,
  links: z.array(detailLinkSchema).readonly(),
}).readonly();

const storySchema = z.object({
  id: z.string(),
  file: z.string(),
  epic: z.string(),
  title: z.string(),
  kind: z.enum(["story", "enabler"]),
  role: z.string().nullable(),
  outcome: z.string(),
  soThat: z.string(),
  demo: z.string().nullable(),
  taskIds: stringList,
  headingLine: z.number().int().positive(),
}).readonly();

const parkedStateSchema = z.object({ since: z.string(), reason: z.string() }).readonly();

const projectSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  scope: z.enum(["product", "portfolio", "derived"]),
  primaryCount: z.number().int().nonnegative(),
  taskCount: z.number().int().nonnegative(),
  parked: parkedStateSchema.nullable(),
}).readonly();

const documentSchema = z.object({
  path: z.string(),
  title: z.string(),
  sha256: z.string(),
  vocabulary: z.object({
    bases: stringList,
    source: z.enum(["document", "configured"]),
  }).passthrough().readonly(),
  taskCount: z.number().int().nonnegative(),
}).readonly();

const findingSchema = z.object({
  id: z.string(),
  file: z.string(),
  epic: z.string(),
  line: z.number().int().positive(),
  status: z.string(),
  severity: z.string().nullable(),
  raw: z.record(z.string(), z.string()).readonly(),
}).readonly();

const issueSchema = z.object({
  kind: dataQualityIssueKindSchema,
  taskId: z.string(),
  file: z.string(),
  line: z.number().int().positive(),
  detail: z.string(),
}).readonly();

export const boardSchema = z.object({
  generatedAt: z.string(),
  revision: z.string(),
  workflow: workflowSchema,
  documents: z.array(documentSchema).readonly(),
  projects: z.array(projectSummarySchema).readonly(),
  tasks: z.array(taskSchema).readonly(),
  details: z.array(detailBlockSchema).readonly(),
  stories: z.array(storySchema).readonly(),
  findings: z.array(findingSchema).readonly(),
  issues: z.array(issueSchema).readonly(),
  statusBases: stringList,
}).readonly();

export type Board = z.infer<typeof boardSchema>;
export type CellRef = z.infer<typeof cellRefSchema>;
export type DataQualityIssue = z.infer<typeof issueSchema>;
export type Dependency = z.infer<typeof dependencySchema>;
export type DetailBlock = z.infer<typeof detailBlockSchema>;
export type DetailField = z.infer<typeof detailFieldSchema>;
export type DetailLink = z.infer<typeof detailLinkSchema>;
export type Finding = z.infer<typeof findingSchema>;
export type ParkedState = z.infer<typeof parkedStateSchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type Readiness = z.infer<typeof readinessSchema>;
export type Story = z.infer<typeof storySchema>;
export type StoryKind = Story["kind"];
export type Task = z.infer<typeof taskSchema>;

export const apiFailureSchema = z.object({
  error: z.string(),
  kind: z.enum(["conflict", "validation", "patch", "forbidden", "git", "history", "note"]).optional(),
  details: z.string().optional(),
}).readonly();
export type ApiFailure = z.infer<typeof apiFailureSchema>;

export const sessionSchema = z.object({
  sourceRef: z.string(),
  sourceSha: z.string(),
  builtAt: z.string(),
  capabilities: z.object({
    history: z.boolean(),
    liveEvents: z.boolean(),
    localWrites: z.boolean(),
  }).readonly(),
}).readonly();
export type BoardSession = z.infer<typeof sessionSchema>;

export const gitStatusSchema = z.object({
  branch: z.string(),
  detached: z.boolean(),
  onProtectedBranch: z.boolean(),
  commitEnabled: z.boolean(),
  changedPlanningFiles: stringList,
  otherChangedFiles: stringList,
  fingerprint: z.string(),
  commitPreviewToken: z.string().regex(/^[a-f0-9]{64}$/),
  suggestedBranch: z.string(),
}).readonly();
export type GitStatusResponse = z.infer<typeof gitStatusSchema>;

export const historyEntrySchema = z.object({
  sha: z.string().nullable(),
  date: z.string(),
  author: z.string().nullable(),
  subject: z.string().nullable(),
  status: z.string().nullable(),
  priority: z.string().nullable(),
  changed: z.array(z.enum(["status", "priority"])).readonly(),
}).readonly();
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export const taskHistorySchema = z.object({
  file: z.string(),
  taskId: z.string(),
  entries: z.array(historyEntrySchema).readonly(),
  commitsScanned: z.number().int().nonnegative(),
}).readonly();
export type TaskHistory = z.infer<typeof taskHistorySchema>;

export const lastChangeSchema = z.object({
  date: z.string(),
  sha: z.string().nullable(),
  subject: z.string().nullable(),
}).readonly();
export type LastChange = z.infer<typeof lastChangeSchema>;
export const lastChangedSchema = z.record(z.string(), lastChangeSchema).readonly();

export const corpusStateSchema = z.object({ corpus: z.string(), git: z.string() }).readonly();
export type CorpusState = z.infer<typeof corpusStateSchema>;

export const writeResultSchema = z.object({ file: z.string(), sha256: z.string() }).readonly();
export const commitResultSchema = z.object({
  branch: z.string(),
  sha: z.string(),
  files: stringList,
}).readonly();
