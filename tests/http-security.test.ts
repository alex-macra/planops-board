import { createServer as createPortProbe, request as httpRequest } from "node:http";

import { createServer as createViteServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  allowedHost,
  allowedOrigin,
  LOOPBACK_HOST,
  MAX_BODY_BYTES,
} from "../server/http.ts";
import { createBoardServer } from "../server/index.ts";
import { loadBoardRuntime } from "../server/runtime.ts";
import { createBoardViteConfig } from "../vite.config.ts";
import { disposableDemo, removeDisposableDemo } from "./fixture.ts";

interface HttpResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: string;
}

interface RunningAdapter {
  readonly port: number;
  close(): Promise<void>;
}

async function availablePort(): Promise<number> {
  const server = createPortProbe();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no TCP port was assigned");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

function request(
  port: number,
  options: {
    readonly method?: string;
    readonly path?: string;
    readonly host?: string;
    readonly origin?: string;
    readonly body?: string;
  } = {},
): Promise<HttpResult> {
  const body = options.body;
  const headers: Record<string, string | number> = {
    connection: "close",
    host: options.host ?? `${LOOPBACK_HOST}:${port}`,
  };
  if (options.origin !== undefined) headers.origin = options.origin;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        hostname: LOOPBACK_HOST,
        port,
        path: options.path ?? "/api/board",
        method: options.method ?? "GET",
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    outgoing.once("error", reject);
    if (body !== undefined) outgoing.write(body);
    outgoing.end();
  });
}

async function startAdapter(kind: "development" | "production", root: string): Promise<RunningAdapter> {
  const port = await availablePort();
  const runtime = await loadBoardRuntime({ repo: root, port });
  if (kind === "development") {
    const server: ViteDevServer = await createViteServer({
      ...createBoardViteConfig(runtime),
      logLevel: "silent",
    });
    await server.listen();
    return { port, close: () => server.close() };
  }

  const server = createBoardServer(runtime);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, LOOPBACK_HOST, resolve);
  });
  return {
    port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

describe("browser request boundary", () => {
  const port = 5174;

  it("accepts only exact loopback Host values", () => {
    expect(allowedHost(`127.0.0.1:${port}`, port)).toBe(true);
    expect(allowedHost(`localhost:${port}`, port)).toBe(true);
    expect(allowedHost(undefined, port)).toBe(false);
    expect(allowedHost(`127.0.0.1.example:${port}`, port)).toBe(false);
    expect(allowedHost(`LOCALHOST:${port}`, port)).toBe(false);
    expect(allowedHost("localhost", port)).toBe(false);
  });

  it("accepts requests without Origin and exact loopback origins", () => {
    expect(allowedOrigin(undefined, port)).toBe(true);
    expect(allowedOrigin(`http://127.0.0.1:${port}`, port)).toBe(true);
    expect(allowedOrigin(`http://localhost:${port}`, port)).toBe(true);
  });

  it.each([
    "https://example.invalid",
    `https://127.0.0.1:${port}`,
    `http://127.0.0.1:${port + 1}`,
    `http://user:password@127.0.0.1:${port}`,
    "not a URL",
  ])("rejects foreign or malformed origin %s", (origin) => {
    expect(allowedOrigin(origin, port)).toBe(false);
  });
});

describe.each(["development", "production"] as const)("%s HTTP adapter", (kind) => {
  let root: string;
  let adapter: RunningAdapter;

  beforeAll(async () => {
    root = await disposableDemo();
    adapter = await startAdapter(kind, root);
  });

  afterAll(async () => {
    if (adapter !== undefined) await adapter.close();
    if (root !== undefined) await removeDisposableDemo(root);
  });

  it("serves API responses with anti-framing headers", async () => {
    const response = await request(adapter.port);
    expect(response.status).toBe(200);
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("applies anti-framing headers to UI responses", async () => {
    const response = await request(adapter.port, { path: "/" });
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("rejects a foreign Host before routing", async () => {
    const response = await request(adapter.port, { host: `example.invalid:${adapter.port}` });
    expect(response.status).toBe(403);
    expect(response.body).toContain("Host");
  });

  it("rejects a foreign Origin before routing", async () => {
    const response = await request(adapter.port, { origin: "https://example.invalid" });
    expect(response.status).toBe(403);
    expect(response.body).toContain("cross-origin");
  });

  it("returns 400 for malformed JSON", async () => {
    const response = await request(adapter.port, {
      method: "POST",
      path: "/api/write",
      body: "{",
    });
    expect(response.status).toBe(400);
    expect(response.body).toContain("valid JSON");
  });

  it("returns 400 for oversized JSON", async () => {
    const response = await request(adapter.port, {
      method: "POST",
      path: "/api/write",
      body: JSON.stringify({ padding: "x".repeat(MAX_BODY_BYTES) }),
    });
    expect(response.status).toBe(400);
    expect(response.body).toContain("too large");
  });
});
