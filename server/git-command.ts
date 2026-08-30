import { execFile } from "node:child_process";

const NULL_HOOKS_PATH = process.platform === "win32" ? "NUL" : "/dev/null";
const HARDENED_GIT_OPTIONS = [
  "-c",
  `core.hooksPath=${NULL_HOOKS_PATH}`,
  "-c",
  "core.fsmonitor=false",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "tag.gpgSign=false",
] as const;

export interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitCommandOptions {
  readonly maxBuffer?: number;
  readonly authorDate?: string;
  readonly committerDate?: string;
  readonly indexFile?: string;
  readonly stdin?: string | Uint8Array;
}

export function sanitizedGitEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([name]) => !name.toUpperCase().startsWith("GIT_")),
  );
}

export function runGitCommand(
  root: string,
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<GitCommandResult> {
  const environment = sanitizedGitEnvironment();
  environment.GIT_LITERAL_PATHSPECS = "1";
  if (options.indexFile !== undefined) environment.GIT_INDEX_FILE = options.indexFile;
  if (options.authorDate !== undefined) environment.GIT_AUTHOR_DATE = options.authorDate;
  if (options.committerDate !== undefined) {
    environment.GIT_COMMITTER_DATE = options.committerDate;
  }
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [...HARDENED_GIT_OPTIONS, ...args],
      {
        cwd: root,
        env: environment,
        encoding: "utf8",
        maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout, stderr });
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  });
}
