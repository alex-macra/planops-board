import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { BoardRuntime } from "../runtime.ts";
import {
  assertSafeRepositoryFile,
  discoverPlanningDocuments,
  discoverWritablePlanningDocuments,
} from "../runtime.ts";
import { buildBoard, type Board, type SourceDocument } from "./model.ts";
import { loadQwenReadinessSource } from "./qwen-readiness.ts";

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function readDiscoveredDocuments(runtime: BoardRuntime): Promise<SourceDocument[]> {
  const paths = await discoverPlanningDocuments(runtime.repositoryRoot, runtime.config, {
    allowEmpty: true,
  });
  const writable = await discoverWritablePlanningDocuments(
    runtime.repositoryRoot,
    runtime.config,
    paths,
  );
  return Promise.all(
    paths.map(async (relativePath) => {
      const absolute = await assertSafeRepositoryFile(runtime.repositoryRoot, relativePath);
      const text = await readFile(absolute, "utf8");
      return { path: relativePath, text, sha256: sha256(text), writable: writable.has(relativePath) };
    }),
  );
}

export async function planningDocuments(runtime: BoardRuntime): Promise<SourceDocument[]> {
  try {
    return await readDiscoveredDocuments(runtime);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
    if (code === "ENOENT" || code === "ENOTDIR") return readDiscoveredDocuments(runtime);
    throw error;
  }
}

export function knownRepositories(runtime: BoardRuntime): ReadonlySet<string> {
  return new Set(runtime.projects.flatMap((project) => [...project.repositories]));
}

export async function loadBoard(runtime: BoardRuntime, generatedAt?: string): Promise<Board> {
  const [documents, source] = await Promise.all([
    planningDocuments(runtime), loadQwenReadinessSource(runtime.repositoryRoot),
  ]);
  return buildBoard(
    documents,
    knownRepositories(runtime),
    runtime.projects,
    generatedAt ?? new Date().toISOString(),
    runtime.config.workflow,
    source,
  );
}
