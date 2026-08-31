import { runGitCommand } from "./git-command.ts";
import type { BoardRuntime } from "./runtime.ts";

export interface SourceIdentity {
  readonly ref: string;
  readonly sha: string;
}

function validateRef(ref: string): void {
  if (ref !== "HEAD" && !ref.startsWith("refs/heads/")) {
    throw new Error(`Git returned an unsupported source ref: ${ref}`);
  }
}

function validateSha(sha: string): void {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) {
    throw new Error("Git returned an invalid source SHA");
  }
}

export async function resolveSourceIdentity(
  readRef: () => Promise<string>,
  readSha: (revision: string) => Promise<string>,
): Promise<SourceIdentity> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ref = await readRef();
    validateRef(ref);
    const sha = await readSha("HEAD");
    validateSha(sha);
    if (await readRef() !== ref) continue;
    const boundSha = await readSha(ref);
    validateSha(boundSha);
    if (boundSha === sha) return { ref, sha };
  }
  throw new Error("Git source changed while its ref and SHA were being resolved");
}

export async function gitSourceIdentity(runtime: BoardRuntime): Promise<SourceIdentity> {
  const readRef = async (): Promise<string> => (
    await runGitCommand(runtime.repositoryRoot, ["rev-parse", "--symbolic-full-name", "HEAD"])
  ).stdout.trim();
  const readSha = async (revision: string): Promise<string> => (
    await runGitCommand(runtime.repositoryRoot, ["rev-parse", "--verify", revision])
  ).stdout.trim();
  return resolveSourceIdentity(readRef, readSha);
}
