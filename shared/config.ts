import { z } from "zod";

export const DEFAULT_PORT = 5176;

const uniqueStrings = (name: string, minimum = 0) =>
  z
    .array(z.string().trim().min(1))
    .min(minimum)
    .superRefine((values, context) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: "custom", message: `${name} must not contain duplicates` });
      }
    });

function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export const repositoryPathSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isSafeRelativePath, "must be a normalized repository-relative path");

const documentGlobSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, context) => {
    if (
      value.includes("\0") ||
      value.includes("\\") ||
      value.includes("..") ||
      /\*{3}/.test(value) ||
      /[?\[\]{}()!+@]/.test(value) ||
      value.startsWith("/") ||
      /^[A-Za-z]:/.test(value) ||
      value.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      context.addIssue({
        code: "custom",
        message: "must be a repository-relative glob using only * and ** wildcards",
      });
    }
    if (!value.toLowerCase().endsWith(".md")) {
      context.addIssue({ code: "custom", message: "include globs must match Markdown files only" });
    }
  });

const exclusionGlobSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, context) => {
    if (
      value.includes("\0") ||
      value.includes("\\") ||
      value.includes("..") ||
      /\*{3}/.test(value) ||
      /[?\[\]{}()!+@]/.test(value) ||
      value.startsWith("/") ||
      /^[A-Za-z]:/.test(value) ||
      value.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      context.addIssue({
        code: "custom",
        message: "must be a repository-relative glob using only * and ** wildcards",
      });
    }
  });

function uniquePatterns<T extends z.ZodType<string>>(item: T, minimum = 0) {
  return z.array(item).min(minimum).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: "document globs must not contain duplicates" });
    }
  });
}

export const workflowConfigSchema = z
  .object({
    statusOrder: uniqueStrings("statusOrder", 1),
    activeStatuses: uniqueStrings("activeStatuses"),
    blockedStatuses: uniqueStrings("blockedStatuses"),
    closedStatuses: uniqueStrings("closedStatuses"),
    dependencySatisfiedStatuses: uniqueStrings("dependencySatisfiedStatuses"),
    priorityOrder: uniqueStrings("priorityOrder", 1),
  })
  .strict()
  .superRefine((workflow, context) => {
    const known = new Set(workflow.statusOrder);
    for (const [field, values] of Object.entries({
      activeStatuses: workflow.activeStatuses,
      blockedStatuses: workflow.blockedStatuses,
      closedStatuses: workflow.closedStatuses,
      dependencySatisfiedStatuses: workflow.dependencySatisfiedStatuses,
    })) {
      for (const value of values) {
        if (!known.has(value)) {
          context.addIssue({
            code: "custom",
            path: [field],
            message: `${JSON.stringify(value)} is not present in statusOrder`,
          });
        }
      }
    }

    const active = new Set(workflow.activeStatuses);
    const blocked = new Set(workflow.blockedStatuses);
    const closed = new Set(workflow.closedStatuses);
    for (const value of active) {
      if (blocked.has(value) || closed.has(value)) {
        context.addIssue({
          code: "custom",
          path: ["activeStatuses"],
          message: `${JSON.stringify(value)} cannot also be blocked or closed`,
        });
      }
    }
    for (const value of blocked) {
      if (closed.has(value)) {
        context.addIssue({
          code: "custom",
          path: ["blockedStatuses"],
          message: `${JSON.stringify(value)} cannot also be closed`,
        });
      }
    }
    for (const value of workflow.dependencySatisfiedStatuses) {
      if (!closed.has(value)) {
        context.addIssue({
          code: "custom",
          path: ["dependencySatisfiedStatuses"],
          message: `${JSON.stringify(value)} must also be a closed status`,
        });
      }
    }
  });

export const boardConfigSchema = z
  .object({
    version: z.literal(1),
    documents: z
      .object({
        include: uniquePatterns(documentGlobSchema, 1),
        exclude: uniquePatterns(exclusionGlobSchema).default([]),
      })
      .strict(),
    projectsFile: repositoryPathSchema.optional(),
    workflow: workflowConfigSchema,
    git: z
      .object({
        protectedBranches: z.array(z.string().trim().min(1)),
        commitEnabled: z.boolean(),
      })
      .strict()
      .superRefine((git, context) => {
        if (new Set(git.protectedBranches).size !== git.protectedBranches.length) {
          context.addIssue({
            code: "custom",
            path: ["protectedBranches"],
            message: "must not contain duplicates",
          });
        }
      }),
    server: z
      .object({ port: z.number().int().min(1024).max(65_535) })
      .strict(),
  })
  .strict();

export type BoardConfig = z.infer<typeof boardConfigSchema>;
export type WorkflowConfig = z.infer<typeof workflowConfigSchema>;

export const DEFAULT_WORKFLOW: WorkflowConfig = {
  statusOrder: ["Ready", "In progress", "Blocked", "Complete"],
  activeStatuses: ["Ready", "In progress"],
  blockedStatuses: ["Blocked"],
  closedStatuses: ["Complete"],
  dependencySatisfiedStatuses: ["Complete"],
  priorityOrder: ["P0", "P1", "P2", "P3"],
};

export function parseBoardConfig(value: unknown): BoardConfig {
  return boardConfigSchema.parse(value);
}
