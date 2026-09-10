import { EventEmitter } from "node:events";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { HistoryError, taskHistory } from "../server/history.ts";
import { handleEvents } from "../server/live.ts";
import { loadBoardRuntime } from "../server/runtime.ts";
import { readCorpusState } from "../server/watch.ts";
import * as watcherState from "../server/watch.ts";
import { disposableDemo, git, removeDisposableDemo } from "./fixture.ts";

const roots: string[] = [];
const closes: (() => void)[] = [];

afterEach(async () => {
  closes.splice(0).forEach((close) => close());
  vi.restoreAllMocks(); vi.useRealTimers();
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

  it("keeps status history across a committed document rename", async () => {
    const fixture = await runtime();
    const source = "plans/moon-garden.md";
    const target = "plans/moon-garden-renamed.md";
    const absoluteSource = path.join(fixture.root, source);
    const text = await readFile(absoluteSource, "utf8");
    await writeFile(
      absoluteSource,
      text.replace("| P1 | Ready | `MGA-001` |", "| P1 | In progress | `MGA-001` |"),
    );
    await git(fixture.root, "add", source);
    await git(fixture.root, "commit", "-m", "Start fictional catalogue filters");
    await rename(absoluteSource, path.join(fixture.root, target));
    await git(fixture.root, "add", "--all", "--", source, target);
    await git(fixture.root, "commit", "-m", "Rename\u001e fictional catalogue plan");

    const history = await taskHistory(fixture.runtime, target, "MGA-002");

    expect(history.commitsScanned).toBe(3);
    expect(history.entries.map((entry) => entry.status)).toEqual(["Ready", "In progress"]);
    expect(history.entries.at(-1)?.subject).toBe("Start fictional catalogue filters");
  });

  it("refuses history for a path outside the discovered documents", async () => {
    const fixture = await runtime();
    await expect(taskHistory(fixture.runtime, "README.md", "MGA-002")).rejects.toBeInstanceOf(
      HistoryError,
    );
  });
});

describe("live corpus state", () => {
  it.each(["request", "response", "initializing", "updates"])("owns one ordered state stream with %s close", async (mode) => {
    const fixture = await runtime(), request = new IncomingMessage(new Socket()), response = new ServerResponse(request);
    closes.push(() => { request.emit("close"); request.socket.destroy(); });
    const frames: string[] = [], release = vi.fn();
    let resolveOld!: (state: watcherState.CorpusState) => void;
    const independentRead = vi.spyOn(watcherState, "readCorpusState")
      .mockReturnValue(new Promise((resolve) => { resolveOld = resolve; }));
    let send: (state: watcherState.CorpusState) => void = () => undefined;
    vi.spyOn(watcherState, "subscribeToCorpus").mockImplementation((_runtime, listener) => {
      send = listener;
      if (mode === "request" || mode === "response") listener({ corpus: "current", git: "git" });
      return release;
    });
    vi.spyOn(response, "writeHead").mockReturnValue(response);
    vi.spyOn(response, "write").mockImplementation((frame) => {
      frames.push(String(frame));
      if (String(frame).startsWith("event: state") && (mode === "request" || mode === "response")) {
        (mode === "request" ? request : response).emit("close");
      }
      return true;
    });
    const end = vi.spyOn(response, "end"); vi.useFakeTimers();
    handleEvents(fixture.runtime, request, response);
    if (mode === "request" || mode === "response") {
      expect(release).toHaveBeenCalledTimes(1); expect(response.writableEnded).toBe(true); expect(vi.getTimerCount()).toBe(0);
    }
    if (mode === "updates") {
      send({ corpus: "first", git: "git" }); send({ corpus: "second", git: "git" });
      resolveOld({ corpus: "old", git: "git" }); await vi.advanceTimersByTimeAsync(0);
      expect(frames.at(-1)).toContain('"corpus":"second"');
      await vi.advanceTimersByTimeAsync(25_000); expect(frames.at(-1)).toBe(": ping\n\n");
    }
    request.emit("close"); response.emit("close");
    const before = [...frames]; resolveOld({ corpus: "old", git: "git" });
    send({ corpus: "after-close", git: "git" }); await vi.advanceTimersByTimeAsync(25_000);
    expect(frames).toEqual(before); expect(frames[0]).toBe("retry: 2000\n\n");
    expect(frames.filter((frame) => frame.startsWith("event: state"))).toHaveLength(mode === "updates" ? 2 : mode === "initializing" ? 0 : 1);
    expect(independentRead).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1); expect(response.writableEnded).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
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
    closes.push(() => request.emit("close"));
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
    const lateRequest = new IncomingMessage(new Socket()), lateResponse = new ServerResponse(lateRequest), replay: string[] = [];
    closes.push(() => { lateRequest.emit("close"); lateRequest.socket.destroy(); });
    vi.spyOn(lateResponse, "write").mockImplementation((frame) => { replay.push(String(frame)); return true; });
    handleEvents(fixture.runtime, lateRequest, lateResponse);
    expect(replay).toEqual(frames);
    request.emit("close");
  });
});
