import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { BoardRuntime } from "../runtime.ts";
import { assertSafeRepositoryFile } from "../runtime.ts";
import { buildBoard, type Board, type SourceDocument } from "./model.ts";

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function planningDocuments(runtime: BoardRuntime): Promise<SourceDocument[]> {
  return Promise.all(
    runtime.documents.map(async (relativePath) => {
      const absolute = await assertSafeRepositoryFile(runtime.repositoryRoot, relativePath);
      const text = await readFile(absolute, "utf8");
      return { path: relativePath, text, sha256: sha256(text) };
    }),
  );
}

export function knownRepositories(runtime: BoardRuntime): ReadonlySet<string> {
  return new Set(runtime.projects.flatMap((project) => [...project.repositories]));
}

export async function loadBoard(runtime: BoardRuntime, generatedAt?: string): Promise<Board> {
  return buildBoard(
    await planningDocuments(runtime),
    knownRepositories(runtime),
    runtime.projects,
    generatedAt ?? new Date().toISOString(),
    runtime.config.workflow,
  );
}
