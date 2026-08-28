import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { HistoryError, taskHistory } from "../server/history.ts";
import { handleEvents } from "../server/live.ts";
import { loadBoardRuntime } from "../server/runtime.ts";
import { readCorpusState } from "../server/watch.ts";
import { disposableDemo, git, removeDisposableDemo } from "./fixture.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeDisposableDemo));
});

async function runtime() {
  const root = await disposableDemo("work/history");
  roots.push(root);
  return { root, runtime: await loadBoardRuntime({ repo: root }) };
}

describe("Git-derived history", () => {
  it("records a committed status transition", async () => {
    const fixture = await runtime();
    const file = "plans/moon-garden.md";
    const absolute = path.join(fixture.root, file);
    const text = await readFile(absolute, "utf8");
    await writeFile(
      absolute,
      text.replace("| P1 | Ready | `MGA-001` |", "| P1 | In progress | `MGA-001` |"),
    );
    await git(fixture.root, "add", file);
    await git(fixture.root, "commit", "-m", "Start fictional catalogue filters");

    const history = await taskHistory(fixture.runtime, file, "MGA-002");
    expect(history.commitsScanned).toBe(2);
    expect(history.entries.map((entry) => entry.status)).toEqual(["Ready", "In progress"]);
    expect(history.entries.at(-1)).toMatchObject({
      subject: "Start fictional catalogue filters",
      changed: ["status"],
    });
  });

  it("refuses history for a path outside the discovered documents", async () => {
    const fixture = await runtime();
    await expect(taskHistory(fixture.runtime, "README.md", "MGA-002")).rejects.toBeInstanceOf(
      HistoryError,
    );
  });
});

describe("live corpus state", () => {
  it("changes for a planning edit but not unrelated dirty work", async () => {
    const fixture = await runtime();
    const initial = await readCorpusState(fixture.runtime);
    await writeFile(path.join(fixture.root, "README.md"), "# Unrelated fictional note\n");
    expect(await readCorpusState(fixture.runtime)).toEqual(initial);

    const file = path.join(fixture.root, "plans", "moon-garden.md");
    await writeFile(file, `${await readFile(file, "utf8")}\nLive fictional edit.\n`);
    expect((await readCorpusState(fixture.runtime)).corpus).not.toBe(initial.corpus);
  });

  it("sends the current state immediately on the event stream", async () => {
    const fixture = await runtime();
    const request = new EventEmitter();
    const response = new EventEmitter() as EventEmitter & {
      writableEnded: boolean;
      destroyed: boolean;
      writeHead(status: number, headers: Record<string, string>): void;
      write(frame: string): void;
      end(): void;
    };
    response.writableEnded = false;
    response.destroyed = false;
    const frames: string[] = [];
    let resolveState!: () => void;
    const stateSent = new Promise<void>((resolve) => {
      resolveState = resolve;
    });
    response.writeHead = (status, headers) => {
      expect(status).toBe(200);
      expect(headers["content-type"]).toContain("text/event-stream");
    };
    response.write = (frame) => {
      frames.push(frame);
      if (frame.startsWith("event: state")) resolveState();
    };
    response.end = () => {
      response.writableEnded = true;
    };

    handleEvents(
      fixture.runtime,
      request as IncomingMessage,
      response as unknown as ServerResponse,
    );
    await stateSent;
    expect(frames[0]).toBe("retry: 2000\n\n");
    expect(frames.some((frame) => frame.includes("event: state\ndata:"))).toBe(true);
    request.emit("close");
  });
});
