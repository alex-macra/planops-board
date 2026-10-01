import { z } from "zod";

const evidenceReferenceSchema = z.string().min(1).max(1_000);

export const deliverySummarySchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1).max(200),
  executor: z.enum(["codex", "claude-code", "qwen3.8"]),
  phase: z.string().min(1).max(80),
  outcome: z.string().min(1).max(200),
  evidence: z.array(evidenceReferenceSchema).max(8).readonly(),
  nextGate: z.string().max(500).nullable(),
  updatedAt: z.string().datetime({ offset: true }),
  productRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i),
}).strict().readonly();

export type DeliverySummary = z.infer<typeof deliverySummarySchema>;

export interface DeliverySummaryField {
  readonly label: string;
  readonly items: readonly string[];
}

/** Invalid, oversized, legacy, or ambiguous fields are inert. */
export function deliverySummaryFromFields(
  fields: readonly DeliverySummaryField[],
): DeliverySummary | null {
  const matches = fields.filter((field) => field.label === "Delivery summary");
  if (matches.length !== 1 || matches[0]!.items.length !== 1) return null;

  const serialized = matches[0]!.items[0]!;
  if (new TextEncoder().encode(serialized).byteLength > 8_192) return null;

  try {
    const parsed = deliverySummarySchema.safeParse(JSON.parse(serialized) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function deliverySummaryHeadline(summary: DeliverySummary): string {
  return `${summary.executor} · ${summary.phase} · ${summary.outcome}`;
}
