/**
 * The client half of the live channel.
 *
 * This hook only *reports* what the server says is on disk. Deciding whether to
 * act on it belongs to `useBoard`, which is the only thing that knows whether a
 * write is in flight or a card is in the air.
 */
import { useEffect, useRef, useState } from "react";

import type { CorpusState } from "./api.ts";
import { corpusStateSchema } from "../shared/contracts.ts";

export type LiveStatus =
  /** Never available: no `EventSource`. The Reload button is the whole story. */
  | "unsupported"
  /** Opening, or reopening after the server restarted. */
  | "connecting"
  | "live"
  /** Gave up. The board still works; it just will not notice anything. */
  | "offline";

/**
 * Subscribe to `/api/events` for the life of the page.
 *
 * `EventSource` reconnects on its own, so there is no backoff here; what this
 * adds is a status the header can show, because a channel that silently stops
 * is worse than none at all - the board looks live and is not.
 */
export function useCorpusEvents(
  onState: (state: CorpusState) => void,
  enabled = true,
): LiveStatus {
  // The callback is read through a ref so a new closure each render does not
  // tear down and rebuild the connection.
  const latest = useRef(onState);
  latest.current = onState;

  const [status, setStatus] = useState<LiveStatus>(() =>
    !enabled || typeof EventSource === "undefined" ? "unsupported" : "connecting",
  );

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") {
      setStatus("unsupported");
      return;
    }

    const source = new EventSource("/api/events");

    const onOpen = (): void => setStatus("live");
    const onError = (): void =>
      setStatus(source.readyState === EventSource.CLOSED ? "offline" : "connecting");
    const onMessage = (event: MessageEvent<string>): void => {
      try {
        const parsed = corpusStateSchema.safeParse(JSON.parse(event.data) as unknown);
        if (parsed.success) latest.current(parsed.data);
      } catch {
        // A frame from a build this page does not understand. Dropping it leaves
        // the board on its last good state rather than on an exception.
      }
    };

    source.addEventListener("open", onOpen);
    source.addEventListener("error", onError);
    source.addEventListener("state", onMessage as EventListener);

    return () => {
      source.removeEventListener("open", onOpen);
      source.removeEventListener("error", onError);
      source.removeEventListener("state", onMessage as EventListener);
      source.close();
    };
  }, [enabled]);

  return status;
}
