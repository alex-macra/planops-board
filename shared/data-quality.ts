import { z } from "zod";

export const DATA_QUALITY_ISSUE_KINDS = [
  "dangling-dependency",
  "ambiguous-dependency",
  "duplicate-dependency",
  "duplicate-task-id",
  "dependency-cycle",
  "dependency-gate",
  "dependency-residue",
  "unknown-status",
  "unknown-priority",
  "self-dependency",
  "detail-without-row",
  "story-incomplete",
  "story-member-unknown",
  "story-member-shared",
] as const;

export const dataQualityIssueKindSchema = z.enum(DATA_QUALITY_ISSUE_KINDS);
export type DataQualityIssueKind = z.infer<typeof dataQualityIssueKindSchema>;
