import { readFile, stat } from "node:fs/promises";

import { z } from "zod";

import { repositoryPathSchema } from "../../shared/config.ts";

export const CROSS_CUTTING = "cross-cutting";
export const UNASSIGNED = "unassigned";

export interface ParkedState {
  readonly since: string;
  readonly reason: string;
}

export interface ProjectDefinition {
  readonly id: string;
  readonly label: string;
  readonly scope: "product" | "portfolio";
  readonly repositories: readonly string[];
  readonly filePrefixes: readonly string[];
  readonly parked?: ParkedState;
}

export interface ProjectSummary {
  readonly id: string;
  readonly label: string;
  readonly scope: "product" | "portfolio" | "derived";
  readonly primaryCount: number;
  readonly taskCount: number;
  readonly parked: ParkedState | null;
}

export const SYNTHETIC_PROJECTS: Readonly<Record<string, string>> = {
  [CROSS_CUTTING]: "Cross-cutting",
  [UNASSIGNED]: "Unassigned",
};

const projectFilePrefixSchema = z.string().trim().min(1).refine((value) => {
  const withoutTrailingSlash = value.endsWith("/") ? value.slice(0, -1) : value;
  return repositoryPathSchema.safeParse(withoutTrailingSlash).success;
}, "must be a normalized repository-relative prefix");

const projectDefinitionSchema = z
  .object({
    id: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    label: z.string().trim().min(1),
    scope: z.enum(["product", "portfolio"]),
    repositories: z.array(z.string().trim().min(1)),
    filePrefixes: z.array(projectFilePrefixSchema),
    parked: z
      .object({
        since: z.iso.date(),
        reason: z.string().trim().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

const projectDefinitionsSchema = z.array(projectDefinitionSchema).superRefine((definitions, context) => {
  const ids = new Set<string>();
  const labels = new Set<string>();
  const repositories = new Map<string, string>();
  const filePrefixes = new Map<string, string>();
  definitions.forEach((definition, index) => {
    if (ids.has(definition.id) || Object.hasOwn(SYNTHETIC_PROJECTS, definition.id)) {
      context.addIssue({ code: "custom", path: [index, "id"], message: "project id must be unique" });
    }
    ids.add(definition.id);
    if (labels.has(definition.label)) {
      context.addIssue({ code: "custom", path: [index, "label"], message: "project label must be unique" });
    }
    labels.add(definition.label);
    if (new Set(definition.repositories).size !== definition.repositories.length) {
      context.addIssue({
        code: "custom",
        path: [index, "repositories"],
        message: "repositories must not contain duplicates",
      });
    }
    if (new Set(definition.filePrefixes).size !== definition.filePrefixes.length) {
      context.addIssue({
        code: "custom",
        path: [index, "filePrefixes"],
        message: "filePrefixes must not contain duplicates",
      });
    }
    for (const repository of definition.repositories) {
      const owner = repositories.get(repository);
      if (owner !== undefined && owner !== definition.id) {
        context.addIssue({
          code: "custom",
          path: [index, "repositories"],
          message: `${repository} is already assigned to ${owner}`,
        });
      }
      repositories.set(repository, definition.id);
    }
    for (const prefix of definition.filePrefixes) {
      const owner = filePrefixes.get(prefix);
      if (owner !== undefined && owner !== definition.id) {
        context.addIssue({
          code: "custom",
          path: [index, "filePrefixes"],
          message: `${prefix} is already assigned to ${owner}`,
        });
      }
      filePrefixes.set(prefix, definition.id);
    }
  });
});

const cached = new Map<
  string,
  { readonly key: string; readonly definitions: readonly ProjectDefinition[] }
>();

export async function loadProjectDefinitions(file: string): Promise<readonly ProjectDefinition[]> {
  const metadata = await stat(file);
  const key = `${metadata.mtimeMs}:${metadata.size}`;
  const current = cached.get(file);
  if (current?.key === key) return current.definitions;

  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`cannot read project map: ${error instanceof Error ? error.message : String(error)}`);
  }
  const definitions = projectDefinitionsSchema.parse(value);
  cached.set(file, { key, definitions });
  return definitions;
}

export interface ProjectSubject {
  readonly file: string;
  readonly repositories: readonly string[];
}

function mappedProjects(
  subject: ProjectSubject,
  definitions: readonly ProjectDefinition[],
): string[] {
  const ids: string[] = [];
  for (const repository of subject.repositories) {
    const match = definitions.find((project) => project.repositories.includes(repository));
    if (match && !ids.includes(match.id)) ids.push(match.id);
  }
  return ids;
}

function fileProject(
  subject: ProjectSubject,
  definitions: readonly ProjectDefinition[],
): ProjectDefinition | null {
  return (
    definitions.find((project) =>
      project.filePrefixes.some((prefix) => subject.file.startsWith(prefix)),
    ) ?? null
  );
}

export function projectsOf(
  subject: ProjectSubject,
  definitions: readonly ProjectDefinition[] = [],
): string[] {
  const mapped = mappedProjects(subject, definitions);
  if (mapped.length > 0) return mapped;
  const fallback = fileProject(subject, definitions);
  return fallback ? [fallback.id] : [];
}

export function primaryProjectOf(
  subject: ProjectSubject,
  definitions: readonly ProjectDefinition[] = [],
): string {
  const mapped = mappedProjects(subject, definitions);
  if (mapped.length === 1) return mapped[0]!;

  const fallback = fileProject(subject, definitions);
  if (mapped.length === 0) return fallback?.id ?? UNASSIGNED;
  return fallback?.scope === "product" ? fallback.id : CROSS_CUTTING;
}

export function summariseProjects(
  tasks: readonly { project: string; projects: readonly string[] }[],
  definitions: readonly ProjectDefinition[] = [],
): ProjectSummary[] {
  const primary = new Map<string, number>();
  const touching = new Map<string, number>();
  for (const task of tasks) {
    primary.set(task.project, (primary.get(task.project) ?? 0) + 1);
    for (const id of new Set([...task.projects, task.project])) {
      touching.set(id, (touching.get(id) ?? 0) + 1);
    }
  }

  const summaries: ProjectSummary[] = definitions.map((project) => ({
    id: project.id,
    label: project.label,
    scope: project.scope,
    primaryCount: primary.get(project.id) ?? 0,
    taskCount: touching.get(project.id) ?? 0,
    parked: project.parked ?? null,
  }));

  for (const [id, label] of Object.entries(SYNTHETIC_PROJECTS)) {
    const count = primary.get(id) ?? 0;
    if (count > 0) {
      summaries.push({
        id,
        label,
        scope: "derived",
        primaryCount: count,
        taskCount: count,
        parked: null,
      });
    }
  }

  return summaries.filter((summary) => summary.taskCount > 0);
}
