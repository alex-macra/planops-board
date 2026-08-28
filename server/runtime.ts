import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import fastGlob from "fast-glob";

import { parseBoardConfig, type BoardConfig } from "../shared/config.ts";
import { runGitCommand } from "./git-command.ts";
import {
  loadProjectDefinitions,
  type ProjectDefinition,
} from "./ledger/projects.ts";

let configValidator: Promise<ValidateFunction> | null = null;

export class RuntimeConfigError extends Error {
  override readonly name = "RuntimeConfigError";
}

export interface ExternalValidator {
  readonly command: string;
  readonly args: readonly string[];
}

export interface BoardRuntime {
  readonly repositoryRoot: string;
  readonly gitDirectory: string;
  readonly engineRoot: string;
  readonly configPath: string;
  readonly config: BoardConfig;
  readonly port: number;
  readonly documents: readonly string[];
  readonly writableFiles: ReadonlySet<string>;
  readonly projects: readonly ProjectDefinition[];
  readonly externalValidator: ExternalValidator | null;
}

export interface RuntimeOptions {
  readonly repo: string;
  readonly config?: string;
  readonly port?: number;
  readonly allowExternalValidator?: boolean;
  readonly engineRoot?: string;
}

function errorText(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    return String((error as { stderr: unknown }).stderr).trim();
  }
  return error instanceof Error ? error.message : String(error);
}

async function bundledConfigValidator(): Promise<ValidateFunction> {
  configValidator ??= readFile(path.join(import.meta.dirname, "..", "schema", "config.schema.json"), "utf8")
    .then((text) => JSON.parse(text) as object)
    .then((schema) => new Ajv2020({ allErrors: true, useDefaults: true, strict: true }).compile(schema));
  return configValidator;
}

function schemaError(error: ErrorObject): string {
  return `${error.instancePath || "/"} ${error.message ?? "is invalid"}`;
}

function relativeToRoot(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    if (!relative) return "";
    throw new RuntimeConfigError(`path escapes the target repository: ${absolutePath}`);
  }
  return relative.split(path.sep).join("/");
}

export function resolveWithin(root: string, relativePath: string): string {
  if (
    !relativePath ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    relativePath.startsWith("/") ||
    /^[A-Za-z]:/.test(relativePath) ||
    relativePath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new RuntimeConfigError(`unsafe repository-relative path: ${relativePath}`);
  }
  const absolute = path.resolve(root, ...relativePath.split("/"));
  relativeToRoot(root, absolute);
  return absolute;
}

export async function assertSafeRepositoryFile(root: string, relativePath: string): Promise<string> {
  const absolute = resolveWithin(root, relativePath);
  let current = root;
  for (const component of relativePath.split("/")) {
    current = path.join(current, component);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new RuntimeConfigError(`symbolic links are not allowed in configured paths: ${relativePath}`);
    }
  }
  const metadata = await stat(absolute);
  if (!metadata.isFile()) {
    throw new RuntimeConfigError(`configured path is not a regular file: ${relativePath}`);
  }
  const canonical = await realpath(absolute);
  relativeToRoot(root, canonical);
  if (canonical !== absolute) {
    throw new RuntimeConfigError(`configured path is not canonical: ${relativePath}`);
  }
  return absolute;
}

export async function canonicalGitRoot(candidate: string): Promise<string> {
  const requested = await realpath(path.resolve(candidate)).catch((error: unknown) => {
    throw new RuntimeConfigError(`cannot resolve target repository: ${errorText(error)}`);
  });
  const metadata = await stat(requested);
  if (!metadata.isDirectory()) throw new RuntimeConfigError(`target is not a directory: ${candidate}`);

  let reported: string;
  try {
    const { stdout } = await runGitCommand(
      requested,
      ["rev-parse", "--show-toplevel"],
      { maxBuffer: 1024 * 1024 },
    );
    reported = stdout.trim();
  } catch (error) {
    throw new RuntimeConfigError(`target is not a Git checkout: ${errorText(error)}`);
  }
  const root = await realpath(reported);
  const relative = path.relative(root, requested);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new RuntimeConfigError("Git reported a worktree that does not contain the requested path");
  }
  return root;
}

async function canonicalGitDirectory(root: string): Promise<string> {
  try {
    const { stdout } = await runGitCommand(
      root,
      ["rev-parse", "--absolute-git-dir"],
      { maxBuffer: 1024 * 1024 },
    );
    return await realpath(stdout.trim());
  } catch (error) {
    throw new RuntimeConfigError(`cannot resolve Git metadata directory: ${errorText(error)}`);
  }
}

async function configuredPath(root: string, option: string | undefined): Promise<string> {
  const relative = option ?? ".projects-board/config.json";
  if (path.isAbsolute(relative) || path.win32.isAbsolute(relative)) {
    throw new RuntimeConfigError("the config path must be repository-relative");
  }
  return assertSafeRepositoryFile(root, relative);
}

export async function loadBoardConfig(root: string, option?: string): Promise<{
  readonly path: string;
  readonly value: BoardConfig;
}> {
  const configPath = await configuredPath(root, option);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch (error) {
    throw new RuntimeConfigError(`cannot read board config: ${errorText(error)}`);
  }
  try {
    const validator = await bundledConfigValidator();
    if (!validator(raw)) {
      throw new Error((validator.errors ?? []).map(schemaError).join("; "));
    }
    return { path: configPath, value: parseBoardConfig(raw) };
  } catch (error) {
    throw new RuntimeConfigError(`invalid board config: ${errorText(error)}`);
  }
}

export async function discoverPlanningDocuments(
  root: string,
  config: BoardConfig,
): Promise<readonly string[]> {
  const matches = await fastGlob(config.documents.include, {
    cwd: root,
    ignore: config.documents.exclude,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    unique: true,
  });
  const documents = [...new Set(matches.map((entry) => entry.split(path.sep).join("/")))].sort();
  if (documents.length === 0) {
    throw new RuntimeConfigError("the configured document globs did not match any Markdown files");
  }
  for (const document of documents) {
    if (!document.toLowerCase().endsWith(".md")) {
      throw new RuntimeConfigError(`document globs matched a non-Markdown file: ${document}`);
    }
    await assertSafeRepositoryFile(root, document);
  }
  return documents;
}

async function externalValidator(root: string, enabled: boolean): Promise<ExternalValidator | null> {
  if (!enabled) return null;
  const relative = ".projects-board/validate";
  const command = await assertSafeRepositoryFile(root, relative).catch((error: unknown) => {
    throw new RuntimeConfigError(
      `--allow-external-validator requires ${relative}: ${errorText(error)}`,
    );
  });
  return { command, args: ["--root", root] };
}

export async function loadBoardRuntime(options: RuntimeOptions): Promise<BoardRuntime> {
  const repositoryRoot = await canonicalGitRoot(options.repo);
  const [{ path: configPath, value: config }, engineRoot, gitDirectory] = await Promise.all([
    loadBoardConfig(repositoryRoot, options.config),
    realpath(path.resolve(options.engineRoot ?? path.join(import.meta.dirname, ".."))),
    canonicalGitDirectory(repositoryRoot),
  ]);
  const port = options.port ?? config.server.port;
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new RuntimeConfigError("port must be an integer from 1024 through 65535");
  }

  const [documents, projects, validator] = await Promise.all([
    discoverPlanningDocuments(repositoryRoot, config),
    config.projectsFile === undefined
      ? Promise.resolve([])
      : assertSafeRepositoryFile(repositoryRoot, config.projectsFile).then(loadProjectDefinitions),
    externalValidator(repositoryRoot, options.allowExternalValidator === true),
  ]);
  return {
    repositoryRoot,
    gitDirectory,
    engineRoot,
    configPath,
    config,
    port,
    documents,
    writableFiles: new Set(documents),
    projects,
    externalValidator: validator,
  };
}
