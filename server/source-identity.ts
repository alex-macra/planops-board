import { runGitCommand } from "./git-command.ts";
import type { BoardRuntime } from "./runtime.ts";

export interface SourceIdentity {
  readonly ref: string;
  readonly sha: string;
}

export type TrackingRelation = "same" | "behind" | "ahead" | "diverged" | "unavailable";

export interface SourceTrackingIdentity {
  readonly ref: string;
  readonly sha: string | null;
  readonly relation: TrackingRelation;
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

export async function gitSourceTrackingIdentity(
  runtime: BoardRuntime,
  source: SourceIdentity,
): Promise<SourceTrackingIdentity | null> {
  const ref = runtime.trackingRef;
  if (ref === null) return null;

  let sha: string;
  try {
    sha = (await runGitCommand(runtime.repositoryRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).stdout.trim();
    validateSha(sha);
  } catch {
    return { ref, sha: null, relation: "unavailable" };
  }
  if (sha === source.sha) return { ref, sha, relation: "same" };

  try {
    const counts = (await runGitCommand(runtime.repositoryRoot, ["rev-list", "--left-right", "--count", `${source.sha}...${sha}`])).stdout.trim();
    const match = /^(\d+)\s+(\d+)$/.exec(counts);
    if (match === null) return { ref, sha, relation: "unavailable" };
    const sourceOnly = Number(match[1]);
    const trackingOnly = Number(match[2]);
    const relation: TrackingRelation = sourceOnly === 0
      ? "behind"
      : trackingOnly === 0
        ? "ahead"
        : "diverged";
    return { ref, sha, relation };
  } catch {
    return { ref, sha, relation: "unavailable" };
  }
}
