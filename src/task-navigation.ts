import type { Task } from "../shared/contracts.ts";

export const TASK_JUMP_QUERY_LIMIT = 200;
export const TASK_JUMP_RESULT_LIMIT = 20;
const TASK_ID_QUERY_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/i;

export interface TaskSearchResult {
  readonly task: Task;
  readonly match: "exact-id" | "id-prefix" | "field";
  readonly selectable: boolean;
}

export interface SummarySource {
  readonly sourceRef: string | null;
  readonly sourceSha: string | null;
  readonly canonicalUrl: string;
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function idCounts(tasks: readonly Task[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) counts.set(task.id, (counts.get(task.id) ?? 0) + 1);
  return counts;
}

function fieldMatch(task: Task, needle: string): boolean {
  return [task.title ?? "", task.outcome, ...task.owners, ...task.repositories]
    .some((value) => normalized(value).includes(needle));
}

export function findTasks(tasks: readonly Task[], query: string): readonly TaskSearchResult[] {
  const needle = normalized(query.slice(0, TASK_JUMP_QUERY_LIMIT));
  if (!needle) return [];
  const counts = idCounts(tasks);
  const exact = tasks.filter((task) => normalized(task.id) === needle);
  if (exact.length > 1) {
    return exact
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
      .slice(0, TASK_JUMP_RESULT_LIMIT)
      .map((task) => ({ task, match: "exact-id" as const, selectable: false }));
  }
  const hasIdMatch = tasks.some((task) => normalized(task.id).includes(needle));
  if (TASK_ID_QUERY_RE.test(query.trim()) && !hasIdMatch) return [];
  const rank = (task: Task): number | null => {
    const id = normalized(task.id);
    if (id === needle) return 0;
    if (id.startsWith(needle)) return 1;
    return id.includes(needle) || fieldMatch(task, needle) ? 2 : null;
  };

  return tasks
    .flatMap((task) => {
      const value = rank(task);
      if (value === null) return [];
      return [{ task, value }];
    })
    .sort((a, b) => a.value - b.value || a.task.id.localeCompare(b.task.id) || a.task.file.localeCompare(b.task.file))
    .slice(0, TASK_JUMP_RESULT_LIMIT)
    .map(({ task, value }) => ({
      task,
      match: value === 0 ? "exact-id" : value === 1 ? "id-prefix" : "field",
      selectable: counts.get(task.id) === 1,
    }));
}

export function canonicalTaskHash(taskId: string): string {
  return `#task=${encodeURIComponent(taskId)}`;
}

export function canonicalTaskUrl(origin: string, pathname: string, taskId: string): string {
  return `${origin}${pathname}${canonicalTaskHash(taskId)}`;
}

function bounded(value: string, max: number): string {
  const compact = value.replace(/[\r\n\t]+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, Math.max(0, max - 3))}...`;
}

function markdownText(value: string, max = 240): string {
  return bounded(value, max).replace(/([\\`*_{}\[\]<>#+\-.!|])/g, "\\$1");
}

function markdownCode(value: string, max = 240): string {
  const text = bounded(value, max);
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const delimiter = "`".repeat(longestRun + 1);
  const content = text.startsWith("`") || text.endsWith("`") ? ` ${text} ` : text;
  return `${delimiter}${content}${delimiter}`;
}

function markdownCanonicalUrl(value: string, taskId: string): string {
  if (value.length > 2048) return "unavailable (link exceeded the export limit)";
  try {
    const url = new URL(value);
    if (
      !/^https?:$/.test(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash !== canonicalTaskHash(taskId)
    ) {
      return "unavailable (link is not a safe Board URL)";
    }
    return `<${url.origin}${url.pathname}${url.hash}>`;
  } catch {
    return "unavailable (link is not a safe Board URL)";
  }
}

function readinessLabel(task: Task): string {
  switch (task.readiness) {
    case "startable": return "startable";
    case "waiting": return "waiting";
    case "needs-gate-check": return "needs gate check";
    default: return "not applicable";
  }
}

function uncertaintyCount(task: Task): number {
  return task.dependencyResidue.length + task.dependencies.filter((dependency) =>
    dependency.gate !== null || dependency.ambiguous || dependency.duplicate || !dependency.resolved,
  ).length;
}

function list(values: readonly string[], formatter: (value: string) => string): string {
  const unique = [...new Set(values)];
  const rendered = unique.slice(0, 12).map(formatter);
  if (unique.length > 12) rendered.push(`and ${unique.length - 12} more`);
  return rendered.length > 0 ? rendered.join(", ") : "none declared";
}

export function taskSummary(task: Task, source: SummarySource): string {
  const sourceRef = source.sourceRef ? markdownCode(source.sourceRef, 120) : "unavailable";
  const sourceSha = source.sourceSha ? markdownCode(source.sourceSha, 128) : "unavailable";
  const checks = uncertaintyCount(task);
  const title = task.title ? markdownText(task.title) : "No canonical detail title recorded.";

  return [
    "## PlanOps Board task summary",
    "",
    `- Task: ${markdownCode(task.id, 120)}`,
    `- Title: ${title}`,
    `- Status: ${markdownText(task.status || "not recorded", 160)}`,
    `- Priority: ${markdownCode(task.priority ?? "not recorded", 32)}`,
    `- Readiness: ${readinessLabel(task)}${checks > 0 ? ` (${checks} manual check${checks === 1 ? "" : "s"})` : ""}`,
    `- Dependencies: ${list(task.dependencies.map((dependency) => dependency.id), (id) => markdownCode(id, 120))}`,
    `- Owner repositories: ${list(task.repositories, (repository) => markdownCode(repository, 120))}`,
    `- Canonical plan: ${markdownCode(task.file, 500)}`,
    `- Source: ${sourceRef} at ${sourceSha}`,
    `- Board link: ${markdownCanonicalUrl(source.canonicalUrl, task.id)}`,
    "",
    "Verify the task at the source revision before acting. This export does not authorize a status change.",
  ].join("\n");
}
