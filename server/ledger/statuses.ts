import { DEFAULT_WORKFLOW } from "../../shared/config.ts";
import {
  parseStatusValue,
  type ParsedStatusValue,
} from "../../shared/status.ts";
import type { Table } from "./parse.ts";

export const CONFIGURED_STATUS_BASES = DEFAULT_WORKFLOW.statusOrder;

export const TASK_ID_HEADERS = new Set(["ID", "Remediation ID"]);
export const ID_PLACEHOLDERS = new Set(["", "\u2014", "None yet"]);

export interface StatusVocabulary {
  readonly bases: readonly string[];
  readonly source: "document" | "configured";
  readonly meanings: ReadonlyMap<string, string>;
}

export type ParsedStatus = ParsedStatusValue;

export function documentVocabulary(
  tables: readonly Table[],
  configuredBases: readonly string[] = CONFIGURED_STATUS_BASES,
): StatusVocabulary {
  const bases: string[] = [];
  const meanings = new Map<string, string>();

  for (const table of tables) {
    if (table.header.length < 2 || table.header[0] !== "Status" || table.header[1] !== "Meaning") {
      continue;
    }
    for (const row of table.rows) {
      const base = row.cells[0];
      if (row.cells.length !== table.header.length || !base || base === "\u2014") continue;
      if (!bases.includes(base)) bases.push(base);
      if (!meanings.has(base)) meanings.set(base, row.cells[1] ?? "");
    }
  }

  if (bases.length === 0) {
    return { bases: [...configuredBases], source: "configured", meanings };
  }
  const ordered = [
    ...configuredBases.filter((base) => bases.includes(base)),
    ...bases.filter((base) => !configuredBases.includes(base)),
  ];
  return { bases: ordered, source: "document", meanings };
}

export function parseStatus(status: string, bases: readonly string[]): ParsedStatus {
  return parseStatusValue(status, bases);
}

export function isValidStatus(status: string, bases: readonly string[]): boolean {
  return parseStatus(status, bases).base !== null;
}

export function composeStatus(base: string, separator: string, qualifier: string): string {
  if (!qualifier) return base;
  const chosen = separator || " - ";
  return base + chosen + qualifier;
}
