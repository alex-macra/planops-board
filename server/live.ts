/**
 * `GET /api/events` - the live channel, as Server-Sent Events.
 *
 * Its own module rather than a route in `api.ts` because everything there is
 * transport-free and returns one `{status, body}`; a stream is the one thing
 * that shape cannot express. Both mounts - `index.ts` for `npm start`, the Vite
 * middleware for `npm run dev` - hand `/api/events` here before that dispatch.
 *
 * SSE rather than a socket or a poll: the payload only ever travels one way, the
 * browser reconnects on its own, and a poll over a corpus this size would mean
 * re-reading every planning document on a timer forever.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import type { BoardRuntime } from "./runtime.ts";
import { subscribeToCorpus, type CorpusState } from "./watch.ts";

/** Under any proxy's idle timeout, and cheap: one comment frame. */
const HEARTBEAT_MS = 25_000;

export function handleEvents(
  runtime: BoardRuntime,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-content-type-options": "nosniff",
    // A proxy that buffers an event stream turns a live board into a dead one
    // that also never reconnects, because the connection looks healthy.
    "x-accel-buffering": "no",
  });

  let stopped = false;
  const write = (frame: string): void => {
    if (stopped || response.writableEnded || response.destroyed) return;
    response.write(frame);
  };

  // The browser's own reconnect backoff. A restarted dev server is picked back
  // up in about two seconds instead of the default five.
  write("retry: 2000\n\n");

  const send = (state: CorpusState): void => {
    write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
  };

  const unsubscribe = subscribeToCorpus(runtime, send);

  // Comment frames rather than events, so a client has no message type to learn
  // and no reason to refetch on a heartbeat.
  const heartbeat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);
  heartbeat.unref?.();

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    unsubscribe();
    response.end();
  };

  request.on("close", stop);
  response.on("close", stop);
}
