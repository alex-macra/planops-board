import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import path from "node:path";

import {
  applySecurityHeaders,
  handleBoardHttpRequest,
  handleHttpFailure,
  LOOPBACK_HOST,
  sendJson,
} from "./http.ts";
import type { BoardRuntime } from "./runtime.ts";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

async function serveStatic(
  runtime: BoardRuntime,
  pathname: string,
  response: ServerResponse,
): Promise<void> {
  const distributionDirectory = path.join(runtime.engineRoot, "dist");
  let distributionStats;
  try {
    distributionStats = await stat(distributionDirectory);
  } catch {
    sendJson(response, 404, { error: "no built UI; run the development server or build first" });
    return;
  }
  if (!distributionStats.isDirectory()) {
    sendJson(response, 404, { error: "the UI build path is not a directory" });
    return;
  }

  let relative: string;
  try {
    relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    sendJson(response, 400, { error: "invalid request path" });
    return;
  }
  let absolute = path.resolve(distributionDirectory, relative);
  if (!absolute.startsWith(`${distributionDirectory}${path.sep}`)) {
    sendJson(response, 403, { error: "forbidden" });
    return;
  }
  try {
    if ((await stat(absolute)).isDirectory()) throw new Error("directory");
  } catch {
    absolute = path.join(distributionDirectory, "index.html");
  }

  applySecurityHeaders(response);
  response.writeHead(200, {
    "content-type": CONTENT_TYPES[path.extname(absolute)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(absolute).on("error", () => response.destroy()).pipe(response);
}

export function createBoardServer(runtime: BoardRuntime): Server {
  return createServer((request, response) => {
    void (async () => {
      try {
        if (await handleBoardHttpRequest(runtime, request, response)) return;
        const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}:${runtime.port}`);
        await serveStatic(runtime, url.pathname, response);
      } catch (error) {
        handleHttpFailure(response, error);
      }
    })();
  });
}

export async function startBoardServer(runtime: BoardRuntime): Promise<Server> {
  const server = createBoardServer(runtime);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(runtime.port, LOOPBACK_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  process.stdout.write(`PlanOps Board on http://${LOOPBACK_HOST}:${runtime.port}\n`);
  process.stdout.write(`Repository: ${runtime.repositoryRoot}\n`);
  return server;
}
