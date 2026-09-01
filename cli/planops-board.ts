#!/usr/bin/env node
import {
  agentQueryFailureSchema,
  agentQueryNameSchema,
  type AgentQueryName,
} from "../shared/agent-query.ts";
import { runAgentQuery } from "../server/agent-query.ts";
import { startBoardServer } from "../server/index.ts";
import { validateRuntime } from "../server/ledger/write.ts";
import { loadBoardRuntime, RuntimeConfigError } from "../server/runtime.ts";

interface ServerCliOptions {
  readonly command: "dev" | "start";
  readonly repo: string;
  readonly config?: string;
  readonly port?: number;
  readonly allowExternalValidator: boolean;
}

interface QueryCliOptions {
  readonly command: "query";
  readonly query: AgentQueryName;
  readonly repo: string;
  readonly config?: string;
}

type CliOptions = ServerCliOptions | QueryCliOptions;

class ArgumentError extends Error {
  override readonly name = "ArgumentError";
}

function usage(): string {
  return [
    "Usage:",
    "  planops-board dev --repo <path> [--config <repository-relative-path>] [--port <port>] [--allow-external-validator]",
    "  planops-board start --repo <path> [--config <repository-relative-path>] [--port <port>] [--allow-external-validator]",
    "  planops-board query startable --repo <path> [--config <repository-relative-path>] --json",
    "  planops-board query stale --repo <path> [--config <repository-relative-path>] --json",
    "  planops-board query issues --repo <path> [--config <repository-relative-path>] --json",
  ].join("\n");
}

function parseServerArguments(command: "dev" | "start", argv: readonly string[]): ServerCliOptions {
  let repo: string | undefined;
  let config: string | undefined;
  let port: number | undefined;
  let allowExternalValidator = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-external-validator") {
      if (allowExternalValidator) throw new ArgumentError("--allow-external-validator was supplied twice");
      allowExternalValidator = true;
      continue;
    }
    if (argument !== "--repo" && argument !== "--config" && argument !== "--port") {
      throw new ArgumentError(`unknown argument: ${argument ?? ""}\n${usage()}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new ArgumentError(`${argument} requires a value`);
    index += 1;
    if (argument === "--repo") {
      if (repo !== undefined) throw new ArgumentError("--repo was supplied twice");
      repo = value;
    } else if (argument === "--config") {
      if (config !== undefined) throw new ArgumentError("--config was supplied twice");
      config = value;
    } else {
      if (port !== undefined) throw new ArgumentError("--port was supplied twice");
      port = Number(value);
      if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
        throw new ArgumentError("--port must be an integer from 1024 through 65535");
      }
    }
  }
  if (repo === undefined) throw new ArgumentError(`--repo is required\n${usage()}`);
  return {
    command,
    repo,
    ...(config === undefined ? {} : { config }),
    ...(port === undefined ? {} : { port }),
    allowExternalValidator,
  };
}

function parseQueryArguments(argv: readonly string[]): QueryCliOptions {
  const parsedQuery = agentQueryNameSchema.safeParse(argv[0]);
  if (!parsedQuery.success) throw new ArgumentError(`unknown query: ${argv[0] ?? ""}\n${usage()}`);
  let repo: string | undefined;
  let config: string | undefined;
  let json = false;

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      if (json) throw new ArgumentError("--json was supplied twice");
      json = true;
      continue;
    }
    if (argument !== "--repo" && argument !== "--config") {
      throw new ArgumentError(`unknown query argument: ${argument ?? ""}\n${usage()}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new ArgumentError(`${argument} requires a value`);
    index += 1;
    if (argument === "--repo") {
      if (repo !== undefined) throw new ArgumentError("--repo was supplied twice");
      repo = value;
    } else {
      if (config !== undefined) throw new ArgumentError("--config was supplied twice");
      config = value;
    }
  }

  if (repo === undefined) throw new ArgumentError(`--repo is required\n${usage()}`);
  if (!json) throw new ArgumentError("agent queries require --json");
  return {
    command: "query",
    query: parsedQuery.data,
    repo,
    ...(config === undefined ? {} : { config }),
  };
}

function parseArguments(argv: readonly string[]): CliOptions {
  const command = argv[0];
  if (command === "dev" || command === "start") {
    return parseServerArguments(command, argv.slice(1));
  }
  if (command === "query") return parseQueryArguments(argv.slice(1));
  throw new Error(usage());
}

async function main(argv: readonly string[]): Promise<void> {
  const options = parseArguments(argv);
  const runtime = await loadBoardRuntime({
    repo: options.repo,
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.command === "query" || options.port === undefined ? {} : { port: options.port }),
    allowExternalValidator: options.command === "query" ? false : options.allowExternalValidator,
  });

  if (options.command === "query") {
    process.stdout.write(`${JSON.stringify(await runAgentQuery(runtime, options.query))}\n`);
    return;
  }

  await validateRuntime(runtime);

  if (options.command === "dev") {
    const [{ createServer }, { createBoardViteConfig }] = await Promise.all([
      import("vite"),
      import("../vite.config.ts"),
    ]);
    const server = await createServer(createBoardViteConfig(runtime));
    try {
      await server.listen();
    } catch (error: unknown) {
      await server.close();
      throw error;
    }
    server.printUrls();
    return;
  }
  await startBoardServer(runtime);
}

function queryCommand(argv: readonly string[]): string {
  const candidate = argv[1];
  return candidate && /^[a-z][a-z0-9-]*$/.test(candidate)
    ? `query.${candidate}`
    : "query.unknown";
}

const argv = process.argv.slice(2);
main(argv).catch((error: unknown) => {
  const message = error instanceof RuntimeConfigError || error instanceof Error
    ? error.message
    : String(error);
  if (argv[0] === "query") {
    const failure = agentQueryFailureSchema.parse({
      contractVersion: 1,
      ok: false,
      command: queryCommand(argv),
      error: {
        code: error instanceof ArgumentError || error instanceof RuntimeConfigError
          ? "invalid_request"
          : "internal_error",
        message,
      },
    });
    if (argv.includes("--json")) process.stdout.write(`${JSON.stringify(failure)}\n`);
    else process.stderr.write(`planops-board: ${message}\n`);
    process.exitCode = error instanceof ArgumentError || error instanceof RuntimeConfigError ? 2 : 1;
    return;
  }
  process.stderr.write(`planops-board: ${message}\n`);
  process.exitCode = 1;
});
