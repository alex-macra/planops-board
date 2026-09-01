/**
 * Normalize heterogeneous ledger tables into tasks, findings and a dependency
 * graph.
 *
 * Task tables can use several header shapes. Columns are matched by header
 * name, never by position, and every original cell is kept
 * in `raw` so the detail drawer can show columns this model does not know about.
 */
import { createHash } from "node:crypto";

import { compareText } from "../../shared/compare.ts";
import { DEFAULT_WORKFLOW, type WorkflowConfig } from "../../shared/config.ts";
import type { DataQualityIssueKind } from "../../shared/data-quality.ts";
import { extractDetailBlocks, type DetailBlock } from "./detail.ts";
import { extractTables, pythonStrip, type Table, type TableRow } from "./parse.ts";
import {
  primaryProjectOf,
  projectsOf,
  summariseProjects,
  type ProjectDefinition,
  type ProjectSummary,
} from "./projects.ts";
import {
  documentVocabulary,
  ID_PLACEHOLDERS,
  parseStatus,
  TASK_ID_HEADERS,
  type StatusVocabulary,
} from "./statuses.ts";
import { isStoryId, storyOf, type Story } from "./stories.ts";

const ID_RE = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;
const DEPENDENCY_TOKEN_RE = /`?([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)(?:@([^`\s,;]+))?`?/g;
const DEPENDENCY_GATE_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** First matching header wins. */
const OWNER_HEADERS = [
  "Repository / owner",
  "Owner repositories",
  "Owner repository or function",
  "Owning repo",
  "Owners",
  "Owner",
  "Repository",
];
const OUTCOME_HEADERS = [
  "Required outcome",
  "Outcome",
  "Definition of done",
  "Behaviour that must survive",
  "Removed surface",
  "Recommendation",
];
const DEPENDENCY_HEADERS = ["Dependencies"];
const PRIORITY_HEADERS = ["Priority", "Severity", "Severity/risk"];

export interface Dependency {
  /** Referenced task ID. */
  readonly id: string;
  /** Readiness predicate after "@", e.g. "offline-ready". Not a status. */
  readonly gate: string | null;
  readonly raw: string;
  /** False when no ledger row anywhere defines `id`. */
  readonly resolved: boolean;
  /** True when more than one ledger row defines `id`. */
  readonly ambiguous: boolean;
  /** True after this ID has already appeared in the same dependency cell. */
  readonly duplicate: boolean;
}

export type Readiness = "startable" | "waiting" | "needs-gate-check" | null;

export interface CellRef {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface Task {
  readonly id: string;
  readonly file: string;
  readonly epic: string;
  readonly section: string | null;
  /** From the row's `### ID - Title` block. */
  readonly title: string | null;
  readonly line: number;
  readonly status: string;
  readonly statusBase: string | null;
  readonly statusQualifier: string;
  readonly statusValid: boolean;
  readonly priority: string | null;
  readonly owners: readonly string[];
  readonly repositories: readonly string[];
  /** The single product this row belongs under; see `server/ledger/projects.ts`. */
  readonly project: string;
  /** Every product the row touches, which is what the scope filter matches on. */
  readonly projects: readonly string[];
  readonly dependencies: readonly Dependency[];
  /** Non-separator text left after every dependency token was extracted. */
  readonly dependencyResidue: readonly string[];
  readonly outcome: string;
  readonly raw: Readonly<Record<string, string>>;
  readonly statusCell: CellRef | null;
  readonly priorityCell: CellRef | null;
  /** Where the board stamps the date a status was set. Absent in registers. */
  readonly outcomeCell: CellRef | null;
  readonly readiness: Readiness;
}

export interface Finding {
  readonly id: string;
  readonly file: string;
  readonly epic: string;
  readonly line: number;
  readonly status: string;
  readonly severity: string | null;
  readonly raw: Readonly<Record<string, string>>;
}

export interface DocumentSummary {
  readonly path: string;
  readonly title: string;
  readonly sha256: string;
  readonly vocabulary: StatusVocabulary;
  readonly taskCount: number;
}

export interface DataQualityIssue {
  readonly kind: DataQualityIssueKind;
  readonly taskId: string;
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

export interface Board {
  readonly generatedAt: string;
  /**
   * A digest of exactly the bytes this board was built from.
   *
   * Derived from the documents rather than stamped with a clock, so two loads of
   * an unchanged corpus produce the same value. That is what lets a tab tell
   * "the disk moved" from "I wrote this myself" without issuing tokens or
   * tracking its own requests - after a write's own reload the two already
   * agree. `generatedAt` cannot do the job: it changes on every call.
   */
  readonly revision: string;
  readonly documents: readonly DocumentSummary[];
  readonly projects: readonly ProjectSummary[];
  readonly tasks: readonly Task[];
  /** Detail blocks stay separate because not every task has one. */
  readonly details: readonly DetailBlock[];
  /**
   * The outcome layer above the rows. Raw as parsed: every bit of a story's
   * state is derived from its member tasks on the client, so that the ledger
   * stays the only place a status is written down.
   */
  readonly stories: readonly Story[];
  readonly findings: readonly Finding[];
  readonly issues: readonly DataQualityIssue[];
  readonly statusBases: readonly string[];
  readonly workflow: WorkflowConfig;
}

export interface SourceDocument {
  readonly path: string;
  readonly text: string;
  readonly sha256: string;
}

function headerIndex(header: readonly string[], candidates: readonly string[]): number {
  for (const candidate of candidates) {
    const index = header.indexOf(candidate);
    if (index !== -1) return index;
  }
  return -1;
}

function cellAt(row: TableRow, index: number): string {
  return index === -1 ? "" : (row.cells[index] ?? "");
}

/**
 * Table normalisation peels symmetric Markdown wrappers from a whole cell.
 * That is right for a single `` `TASK-001` `` value, but it turns two adjacent
 * code spans into unbalanced backticks. Dependency parsing needs the original
 * cell punctuation so it can distinguish valid code spans from malformed ones.
 */
function dependencyCellAt(row: TableRow, index: number): string {
  if (index === -1) return "";
  const span = row.spans[index];
  if (!span) return cellAt(row, index);
  return pythonStrip(row.text.slice(span.start, span.end)).replaceAll("\\|", "|");
}

/** Split repository or role owners from a table cell. */
function splitOwners(value: string): string[] {
  return value
    .split(/[;,]|\band\b/)
    .map((part) => part.replaceAll("`", "").trim())
    .filter((part) => part.length > 0 && part !== "\u2014");
}

/** Owners that name an actual repository directory, not a role. */
function repositoriesOf(owners: readonly string[], knownRepositories: ReadonlySet<string>): string[] {
  return owners.filter((owner) => knownRepositories.has(owner));
}

export interface ParsedDependencies {
  readonly dependencies: readonly Omit<Dependency, "resolved" | "ambiguous" | "duplicate">[];
  readonly residue: readonly string[];
}

/** Extract every task token while retaining anything the grammar cannot explain. */
export function parseDependencies(value: string): ParsedDependencies {
  const trimmed = pythonStrip(value);
  if (!trimmed || trimmed === "\u2014" || /^none\.?$/i.test(trimmed)) {
    return { dependencies: [], residue: [] };
  }

  const dependencies: Omit<Dependency, "resolved" | "ambiguous" | "duplicate">[] = [];
  const residualParts: string[] = [];
  let cursor = 0;
  for (const match of value.matchAll(DEPENDENCY_TOKEN_RE)) {
    const index = match.index ?? 0;
    residualParts.push(value.slice(cursor, index));
    const raw = match[0];
    const id = match[1];
    const gateCandidate = match[2] ?? null;
    const gate = gateCandidate !== null && DEPENDENCY_GATE_RE.test(gateCandidate)
      ? gateCandidate
      : null;
    if (raw && id && ID_RE.test(id)) {
      dependencies.push({ id, gate, raw: gateCandidate !== null && gate === null ? id : raw });
      if (gateCandidate !== null && gate === null) residualParts.push(`@${gateCandidate}`);
      if ([...raw].filter((character) => character === "`").length === 1) residualParts.push("`");
    }
    cursor = index + raw.length;
  }
  residualParts.push(value.slice(cursor));

  const residue = residualParts
    .join(" ")
    .split(/[;,]/)
    .map((part) => pythonStrip(part))
    .filter(Boolean);

  return { dependencies, residue };
}

function dependencyCycles(
  drafts: readonly { readonly id: string; readonly pending: ParsedDependencies }[],
  uniqueIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const edges = new Map(
    drafts
      .filter((draft) => uniqueIds.has(draft.id))
      .map((draft) => [
        draft.id,
        draft.pending.dependencies
          .map((dependency) => dependency.id)
          .filter((id) => uniqueIds.has(id)),
      ] as const),
  );
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const cyclic = new Set<string>();

  const visit = (id: string): void => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      const start = stack.lastIndexOf(id);
      for (const member of stack.slice(start)) cyclic.add(member);
      return;
    }
    state.set(id, "visiting");
    stack.push(id);
    for (const dependency of edges.get(id) ?? []) visit(dependency);
    stack.pop();
    state.set(id, "done");
  };

  for (const id of edges.keys()) visit(id);
  return cyclic;
}

function isTaskTable(table: Table): boolean {
  return table.header.length > 0 && TASK_ID_HEADERS.has(table.header[0]!);
}

export interface RowValues {
  readonly status: string | null;
  readonly priority: string | null;
}

/**
 * Every row's status and priority, from any revision of a document.
 *
 * History replays this over past commits, where the header shape may differ
 * from today's, so it resolves columns by name exactly as `buildBoard` does
 * rather than by remembered position. One pass per revision, because the work
 * is in parsing the tables and one parse answers for every row in them.
 */
export function rowValues(text: string): Map<string, RowValues> {
  const values = new Map<string, RowValues>();
  for (const table of extractTables(text.split("\n"))) {
    if (!isTaskTable(table)) continue;
    const statusIndex = table.header.indexOf("Status");
    const priorityIndex = headerIndex(table.header, PRIORITY_HEADERS);
    for (const row of table.rows) {
      const id = row.cells[0] ?? "";
      if (ID_PLACEHOLDERS.has(id) || !ID_RE.test(id) || values.has(id)) continue;
      values.set(id, {
        status: statusIndex === -1 ? null : cellAt(row, statusIndex),
        priority: priorityIndex === -1 ? null : cellAt(row, priorityIndex) || null,
      });
    }
  }
  return values;
}

/**
 * Sorted, so the digest describes the corpus rather than the order it was read
 * in: the watcher and `/api/board` must agree byte for byte or every event would
 * read as a change.
 */
export function revisionOf(documents: readonly SourceDocument[]): string {
  const hash = createHash("sha256");
  for (const document of [...documents].sort((a, b) => compareText(a.path, b.path))) {
    hash.update(`${document.path}\u0000${document.sha256}\n`);
  }
  return hash.digest("hex");
}

function isFindingTable(table: Table): boolean {
  return table.header[0] === "Finding ID";
}

function rawRecord(header: readonly string[], row: TableRow): Record<string, string> {
  const record: Record<string, string> = {};
  header.forEach((name, index) => {
    if (name) record[name] = row.cells[index] ?? "";
  });
  return record;
}

export function buildBoard(
  documents: readonly SourceDocument[],
  knownRepositories: ReadonlySet<string>,
  projectDefinitions: readonly ProjectDefinition[] = [],
  generatedAt: string = new Date().toISOString(),
  workflow: WorkflowConfig = DEFAULT_WORKFLOW,
): Board {
  const summaries: DocumentSummary[] = [];
  const findings: Finding[] = [];
  const issues: DataQualityIssue[] = [];
  const details: DetailBlock[] = [];
  const stories: Story[] = [];
  const drafts: (Omit<Task, "dependencies" | "dependencyResidue" | "readiness"> & {
    pending: ParsedDependencies;
  })[] = [];

  for (const document of documents) {
    const lines = document.text.split("\n");
    const tables = extractTables(lines);
    const vocabulary = documentVocabulary(tables, workflow.statusOrder);
    const epic = lines.find((line) => line.startsWith("# "))?.slice(2).trim() ?? document.path;

    const blocks = extractDetailBlocks(lines, document.path);
    const titles = new Map(blocks.map((block) => [block.id, block.title]));
    details.push(...blocks);

    for (const block of blocks) {
      if (!isStoryId(block.id)) continue;
      const story = storyOf(block, epic);
      if (story) stories.push(story);
      else {
        issues.push({
          kind: "story-incomplete",
          taskId: block.id,
          file: document.path,
          line: block.headingLine,
          detail: "is a story heading with no Outcome and So that, so no sentence can be written",
        });
      }
    }

    let taskCount = 0;

    for (const table of tables) {
      const statusIndex = table.header.indexOf("Status");
      const priorityIndex = headerIndex(table.header, PRIORITY_HEADERS);

      if (isFindingTable(table)) {
        for (const row of table.rows) {
          const id = row.cells[0] ?? "";
          if (row.cells.length !== table.header.length || !ID_RE.test(id)) continue;
          findings.push({
            id,
            file: document.path,
            epic,
            line: row.line,
            status: cellAt(row, statusIndex),
            severity: priorityIndex === -1 ? null : cellAt(row, priorityIndex),
            raw: rawRecord(table.header, row),
          });
        }
        continue;
      }

      if (!isTaskTable(table)) continue;

      const ownerIndex = headerIndex(table.header, OWNER_HEADERS);
      const outcomeIndex = headerIndex(table.header, OUTCOME_HEADERS);
      const dependencyIndex = headerIndex(table.header, DEPENDENCY_HEADERS);

      for (const row of table.rows) {
        const id = row.cells[0] ?? "";
        if (row.cells.length !== table.header.length) continue;
        if (ID_PLACEHOLDERS.has(id) || !ID_RE.test(id)) continue;

        const status = cellAt(row, statusIndex);
        const parsed = parseStatus(status, vocabulary.bases);
        const owners = splitOwners(cellAt(row, ownerIndex));
        const pending = parseDependencies(dependencyCellAt(row, dependencyIndex));
        const subject = {
          file: document.path,
          repositories: repositoriesOf(owners, knownRepositories),
        };

        if (statusIndex !== -1 && parsed.base === null) {
          issues.push({
            kind: "unknown-status",
            taskId: id,
            file: document.path,
            line: row.line,
            detail: `status ${JSON.stringify(status)} matches no base state in ${vocabulary.source} vocabulary`,
          });
        }

        const priority = priorityIndex === -1 ? null : cellAt(row, priorityIndex) || null;
        if (priority !== null && !workflow.priorityOrder.includes(priority)) {
          issues.push({
            kind: "unknown-priority",
            taskId: id,
            file: document.path,
            line: row.line,
            detail: `priority ${JSON.stringify(priority)} is not present in the configured priority order`,
          });
        }

        drafts.push({
          id,
          file: document.path,
          epic,
          section: table.section,
          title: titles.get(id) ?? null,
          line: row.line,
          status,
          statusBase: parsed.base,
          statusQualifier: parsed.qualifier,
          statusValid: parsed.base !== null,
          priority,
          owners,
          repositories: subject.repositories,
          project: primaryProjectOf(subject, projectDefinitions),
          projects: projectsOf(subject, projectDefinitions),
          outcome: cellAt(row, outcomeIndex),
          raw: rawRecord(table.header, row),
          statusCell:
            statusIndex === -1
              ? null
              : { file: document.path, line: row.line, column: statusIndex },
          priorityCell:
            priorityIndex === -1
              ? null
              : { file: document.path, line: row.line, column: priorityIndex },
          outcomeCell:
            outcomeIndex === -1
              ? null
              : { file: document.path, line: row.line, column: outcomeIndex },
          pending,
        });
        taskCount += 1;
      }
    }

    summaries.push({
      path: document.path,
      title: epic,
      sha256: document.sha256,
      vocabulary,
      taskCount,
    });
  }

  const draftsById = new Map<string, typeof drafts>();
  for (const draft of drafts) {
    const matches = draftsById.get(draft.id);
    if (matches) matches.push(draft);
    else draftsById.set(draft.id, [draft]);
  }
  const uniqueIds = new Set(
    [...draftsById.entries()].flatMap(([id, matches]) => (matches.length === 1 ? [id] : [])),
  );
  const byId = new Map(
    [...draftsById.entries()].flatMap(([id, matches]) =>
      matches.length === 1 ? [[id, matches[0]!] as const] : [],
    ),
  );
  for (const [id, matches] of draftsById) {
    if (matches.length === 1) continue;
    for (const match of matches) {
      issues.push({
        kind: "duplicate-task-id",
        taskId: id,
        file: match.file,
        line: match.line,
        detail: `${id} is defined by ${matches.length} ledger rows`,
      });
    }
  }
  const cyclicIds = dependencyCycles(drafts, uniqueIds);

  // A block with no row is a task the board cannot show, edit, or count.
  for (const block of details) {
    // Stories intentionally have no row because their status comes from tasks.
    if (byId.has(block.id) || isStoryId(block.id)) continue;
    issues.push({
      kind: "detail-without-row",
      taskId: block.id,
      file: block.file,
      line: block.headingLine,
      detail: "has a detail block but no ledger row, so it has no status and cannot be tracked",
    });
  }

  // A task in two stories would make both progress summaries ambiguous.
  const claimedBy = new Map<string, string>();
  for (const story of stories) {
    for (const taskId of story.taskIds) {
      if (!byId.has(taskId)) {
        issues.push({
          kind: "story-member-unknown",
          taskId: story.id,
          file: story.file,
          line: story.headingLine,
          detail: `delivers ${taskId}, which no ledger row defines`,
        });
        continue;
      }
      const owner = claimedBy.get(taskId);
      if (owner) {
        issues.push({
          kind: "story-member-shared",
          taskId: story.id,
          file: story.file,
          line: story.headingLine,
          detail: `delivers ${taskId}, which ${owner} already claims`,
        });
      } else claimedBy.set(taskId, story.id);
    }
  }

  const activeStatuses = new Set(workflow.activeStatuses);
  const blockedStatuses = new Set(workflow.blockedStatuses);
  const closedStatuses = new Set(workflow.closedStatuses);
  const dependencySatisfiedStatuses = new Set(workflow.dependencySatisfiedStatuses);
  const tasks: Task[] = drafts.map((draft) => {
    const seenDependencies = new Set<string>();
    const dependencies: Dependency[] = draft.pending.dependencies.map((dependency) => {
      const matches = draftsById.get(dependency.id) ?? [];
      const resolved = matches.length === 1;
      const ambiguous = matches.length > 1;
      const duplicate = seenDependencies.has(dependency.id);
      seenDependencies.add(dependency.id);
      if (!resolved) {
        issues.push({
          kind: ambiguous ? "ambiguous-dependency" : "dangling-dependency",
          taskId: draft.id,
          file: draft.file,
          line: draft.line,
          detail: ambiguous
            ? `depends on ${dependency.id}, which ${matches.length} ledger rows define`
            : `depends on ${dependency.id}, which no ledger row defines`,
        });
      }
      if (duplicate) {
        issues.push({
          kind: "duplicate-dependency",
          taskId: draft.id,
          file: draft.file,
          line: draft.line,
          detail: `lists ${dependency.id} more than once`,
        });
      }
      if (dependency.gate) {
        issues.push({
          kind: "dependency-gate",
          taskId: draft.id,
          file: draft.file,
          line: draft.line,
          detail: `${dependency.id} also requires gate ${dependency.gate}`,
        });
      }
      if (dependency.id === draft.id) {
        issues.push({
          kind: "self-dependency",
          taskId: draft.id,
          file: draft.file,
          line: draft.line,
          detail: "task lists itself as a dependency",
        });
      }
      return { ...dependency, resolved, ambiguous, duplicate };
    });
    for (const residue of draft.pending.residue) {
      issues.push({
        kind: "dependency-residue",
        taskId: draft.id,
        file: draft.file,
        line: draft.line,
        detail: `dependency text was not interpreted: ${JSON.stringify(residue)}`,
      });
    }
    if (cyclicIds.has(draft.id)) {
      issues.push({
        kind: "dependency-cycle",
        taskId: draft.id,
        file: draft.file,
        line: draft.line,
        detail: "task participates in a dependency cycle",
      });
    }

    const closed = draft.statusBase !== null && closedStatuses.has(draft.statusBase);
    const needsGateCheck =
      !draft.statusValid ||
      !activeStatuses.has(draft.statusBase ?? "") ||
      blockedStatuses.has(draft.statusBase ?? "") ||
      draft.pending.residue.length > 0 ||
      dependencies.some(
        (dependency) =>
          dependency.gate !== null ||
          !dependency.resolved ||
          dependency.ambiguous ||
          dependency.duplicate ||
          dependency.id === draft.id,
      ) ||
      dependencies.some((dependency) => cyclicIds.has(dependency.id)) ||
      dependencies.some(
        (dependency) => dependency.resolved && byId.get(dependency.id)?.statusValid === false,
      ) ||
      cyclicIds.has(draft.id) ||
      (draftsById.get(draft.id)?.length ?? 0) > 1;
    const waiting = dependencies.some(
      (dependency) => !dependencySatisfiedStatuses.has(byId.get(dependency.id)?.statusBase ?? ""),
    );
    const { pending: _pending, ...rest } = draft;
    return {
      ...rest,
      dependencies,
      dependencyResidue: draft.pending.residue,
      readiness: closed
        ? null
        : needsGateCheck
          ? "needs-gate-check"
          : waiting
            ? "waiting"
            : "startable",
    };
  });

  const statusBases = [
    ...new Set(tasks.flatMap((task) => (task.statusBase === null ? [] : [task.statusBase]))),
  ];

  return {
    generatedAt,
    revision: revisionOf(documents),
    documents: summaries,
    projects: summariseProjects(tasks, projectDefinitions),
    tasks,
    details,
    stories,
    findings,
    issues,
    statusBases,
    workflow,
  };
}
