import type { IncomingMessage, ServerResponse } from "node:http";

import { handleApi } from "./api.ts";
import { handleEvents } from "./live.ts";
import type { BoardRuntime } from "./runtime.ts";

export const LOOPBACK_HOST = "127.0.0.1";
export const MAX_BODY_BYTES = 1024 * 1024;

export class HttpRequestError extends Error {
  override readonly name = "HttpRequestError";
}

export function allowedHost(host: string | undefined, port: number): boolean {
  return host === `${LOOPBACK_HOST}:${port}` || host === `localhost:${port}`;
}

export function allowedOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true;
  return origin === `http://${LOOPBACK_HOST}:${port}` || origin === `http://localhost:${port}`;
}

export function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
}

export function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  applySecurityHeaders(response);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  let oversized = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      oversized = true;
      chunks.length = 0;
      continue;
    }
    if (!oversized) chunks.push(buffer);
  }
  if (oversized) throw new HttpRequestError("request body too large");
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpRequestError("request body must be valid JSON");
  }
}

function internalError(response: ServerResponse, error: unknown): void {
  process.stderr.write(`planops-board: ${error instanceof Error ? error.message : String(error)}\n`);
  if (response.headersSent) {
    response.destroy();
    return;
  }
  sendJson(response, 500, { error: "internal server error" });
}

export async function handleBoardHttpRequest(
  runtime: BoardRuntime,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  applySecurityHeaders(response);
  if (!allowedHost(request.headers.host, runtime.port)) {
    sendJson(response, 403, { error: "request Host is not accepted" });
    return true;
  }
  if (!allowedOrigin(request.headers.origin, runtime.port)) {
    sendJson(response, 403, { error: "cross-origin requests are not accepted" });
    return true;
  }

  let url: URL;
  try {
    url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}:${runtime.port}`);
  } catch {
    sendJson(response, 400, { error: "invalid request URL" });
    return true;
  }
  if (!url.pathname.startsWith("/api/")) return false;
  if (url.pathname === "/api/events") {
    handleEvents(runtime, request, response);
    return true;
  }

  try {
    const payload = request.method === "POST" ? await readJsonBody(request) : undefined;
    const result = await handleApi(
      runtime,
      request.method ?? "GET",
      url.pathname,
      payload,
      url.searchParams,
    );
    sendJson(response, result.status, result.body);
  } catch (error) {
    if (error instanceof HttpRequestError) {
      sendJson(response, 400, { error: error.message });
    } else {
      internalError(response, error);
    }
  }
  return true;
}

export function handleHttpFailure(response: ServerResponse, error: unknown): void {
  internalError(response, error);
}
