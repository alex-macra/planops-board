import type { BoardRuntime } from "../runtime.ts";
import { buildBoard } from "./model.ts";
import { extractTables } from "./parse.ts";
import { knownRepositories, planningDocuments } from "./corpus.ts";
import { ID_PLACEHOLDERS, TASK_ID_HEADERS } from "./statuses.ts";

export class StructuralValidationError extends Error {
  override readonly name = "StructuralValidationError";
  readonly details: readonly string[];

  constructor(details: readonly string[]) {
    super("the planning corpus does not satisfy the configured Markdown ledger structure");
    this.details = details;
  }
}

export async function validateBoardRuntime(runtime: BoardRuntime): Promise<void> {
  const documents = await planningDocuments(runtime);
  const details: string[] = [];

  for (const document of documents) {
    for (const table of extractTables(document.text.split("\n"))) {
      if (!TASK_ID_HEADERS.has(table.header[0] ?? "")) continue;
      for (const row of table.rows) {
        const id = row.cells[0] ?? "";
        if (ID_PLACEHOLDERS.has(id)) continue;
        if (row.cells.length !== table.header.length) {
          details.push(
            `${document.path}:${row.line}: row has ${row.cells.length} cells; expected ${table.header.length}`,
          );
        }
      }
    }
  }

  const board = buildBoard(
    documents,
    knownRepositories(runtime),
    runtime.projects,
    new Date(0).toISOString(),
    runtime.config.workflow,
  );
  const structuralKinds = new Set(["duplicate-task-id", "unknown-status", "unknown-priority"]);
  for (const issue of board.issues) {
    if (structuralKinds.has(issue.kind)) {
      details.push(`${issue.file}:${issue.line}: ${issue.taskId}: ${issue.detail}`);
    }
  }

  if (details.length > 0) throw new StructuralValidationError(details);
}
