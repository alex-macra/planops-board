import { createHash } from "node:crypto";

import {
  agentQueryIssuesSuccessSchema,
  agentQueryStaleSuccessSchema,
  agentQueryStartableSuccessSchema,
  sortDataQualityIssues,
  toAgentQueryStaleItem,
  toAgentQueryStartableItem,
  type AgentQueryName,
  type AgentQuerySuccess,
} from "../shared/agent-query.ts";
import {
  selectStaleTasks,
  selectStartableTasks,
  STALE_DAYS,
} from "../shared/task-selectors.ts";
import { toBoardResponse } from "./board-response.ts";
import { lastChangedByFile } from "./history.ts";
import { loadBoard } from "./ledger/corpus.ts";
import type { BoardRuntime } from "./runtime.ts";
import { gitSourceIdentity } from "./source-identity.ts";

export async function runAgentQuery(
  runtime: BoardRuntime,
  query: AgentQueryName,
  now = new Date(),
): Promise<AgentQuerySuccess> {
  const [ledgerBoard, source] = await Promise.all([
    loadBoard(runtime, now.toISOString()),
    gitSourceIdentity(runtime),
  ]);
  const board = toBoardResponse(ledgerBoard);
  const corpusRevision = createHash("sha256")
    .update("agent-query-corpus-v1\0")
    .update(board.revision)
    .update("\0workflow\0")
    .update(JSON.stringify(runtime.config.workflow))
    .update("\0projects\0")
    .update(JSON.stringify(runtime.projects))
    .digest("hex");
  const boundSource = { ...source, corpusRevision };

  if (query === "startable") {
    const items = selectStartableTasks(board).map((selection) =>
      toAgentQueryStartableItem(board, selection),
    );
    return agentQueryStartableSuccessSchema.parse({
      contractVersion: 1,
      ok: true,
      command: "query.startable",
      source: boundSource,
      data: { total: items.length, items },
    });
  }

  if (query === "stale") {
    const lastChanged = await lastChangedByFile(
      runtime,
      board.documents.map((document) => document.path),
    );
    const locations = new Map<string, number>();
    for (const task of board.tasks) {
      const key = `${task.file}\0${task.id}`;
      locations.set(key, (locations.get(key) ?? 0) + 1);
    }
    const items = selectStaleTasks(
      board,
      (task) => locations.get(`${task.file}\0${task.id}`) === 1
        ? lastChanged[task.file]?.[task.id]
        : undefined,
      now,
    ).map((selection) =>
      toAgentQueryStaleItem(board, selection),
    );
    return agentQueryStaleSuccessSchema.parse({
      contractVersion: 1,
      ok: true,
      command: "query.stale",
      source: boundSource,
      data: {
        asOfDate: now.toISOString().slice(0, 10),
        thresholdDays: STALE_DAYS,
        total: items.length,
        items,
      },
    });
  }

  const items = sortDataQualityIssues(board.issues);
  return agentQueryIssuesSuccessSchema.parse({
    contractVersion: 1,
    ok: true,
    command: "query.issues",
    source: boundSource,
    data: { total: items.length, items },
  });
}
