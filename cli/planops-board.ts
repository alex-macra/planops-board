#!/usr/bin/env node
import { startBoardServer } from "../server/index.ts";
import { validateRuntime } from "../server/ledger/write.ts";
import { loadBoardRuntime, RuntimeConfigError } from "../server/runtime.ts";

interface CliOptions {
  readonly command: "dev" | "start";
  readonly repo: string;
  readonly config?: string;
  readonly port?: number;
  readonly allowExternalValidator: boolean;
}

function usage(): string {
  return [
    "Usage:",
    "  planops-board dev --repo <path> [--config <repository-relative-path>] [--port <port>] [--allow-external-validator]",
    "  planops-board start --repo <path> [--config <repository-relative-path>] [--port <port>] [--allow-external-validator]",
  ].join("\n");
}

function parseArguments(argv: readonly string[]): CliOptions {
  const command = argv[0];
  if (command !== "dev" && command !== "start") throw new Error(usage());

  let repo: string | undefined;
  let config: string | undefined;
  let port: number | undefined;
  let allowExternalValidator = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-external-validator") {
      if (allowExternalValidator) throw new Error("--allow-external-validator was supplied twice");
      allowExternalValidator = true;
      continue;
    }
    if (argument !== "--repo" && argument !== "--config" && argument !== "--port") {
      throw new Error(`unknown argument: ${argument ?? ""}\n${usage()}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    index += 1;
    if (argument === "--repo") {
      if (repo !== undefined) throw new Error("--repo was supplied twice");
      repo = value;
    } else if (argument === "--config") {
      if (config !== undefined) throw new Error("--config was supplied twice");
      config = value;
    } else {
      if (port !== undefined) throw new Error("--port was supplied twice");
      port = Number(value);
      if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
        throw new Error("--port must be an integer from 1024 through 65535");
      }
    }
  }
  if (repo === undefined) throw new Error(`--repo is required\n${usage()}`);
  return {
    command,
    repo,
    ...(config === undefined ? {} : { config }),
    ...(port === undefined ? {} : { port }),
    allowExternalValidator,
  };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const runtime = await loadBoardRuntime({
    repo: options.repo,
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.port === undefined ? {} : { port: options.port }),
    allowExternalValidator: options.allowExternalValidator,
  });
  await validateRuntime(runtime);

  if (options.command === "dev") {
    const [{ createServer }, { createBoardViteConfig }] = await Promise.all([
      import("vite"),
      import("../vite.config.ts"),
    ]);
    const server = await createServer(createBoardViteConfig(runtime));
    await server.listen();
    server.printUrls();
    return;
  }
  await startBoardServer(runtime);
}

main().catch((error: unknown) => {
  const message = error instanceof RuntimeConfigError || error instanceof Error
    ? error.message
    : String(error);
  process.stderr.write(`planops-board: ${message}\n`);
  process.exitCode = 1;
});
