import type { JSX } from "react";

import type { LiveStatus } from "../live.ts";

interface Props {
  readonly status: LiveStatus;
  /** Disk has moved and the refresh is being held for a drag or a write. */
  readonly behind: boolean;
  readonly refreshedAt: number | null;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Says whether the board is actually watching the corpus.
 *
 * A channel that has silently stopped is worse than no channel at all: the board
 * looks live, so the Reload button stops being pressed, and the tab drifts until
 * its next edit comes back a `409`. So the failure states are the ones with
 * words on them, and "live" is the one that recedes to a dot.
 */
export function LiveIndicator({ status, behind, refreshedAt }: Props): JSX.Element | null {
  if (status === "unsupported") return null;

  if (status === "offline" || status === "connecting") {
    const connecting = status === "connecting";
    return (
      <span
        className="live-indicator live-indicator-warn"
        title={
          connecting
            ? "Connecting to the corpus watcher. Until it does, the board only updates when you reload."
            : "Not watching the repository. External file or Git changes will not appear until you reload."
        }
      >
        <span className="live-dot" aria-hidden />
        {connecting ? "Connecting" : "Not watching"}
      </span>
    );
  }

  return (
    <span
      className="live-indicator"
      title={
        behind
          ? "The ledgers changed on disk. Refreshing as soon as this drag or write finishes."
          : refreshedAt === null
            ? "Watching the ledgers for changes made outside this tab."
            : `Last refreshed from disk at ${clock(refreshedAt)}.`
      }
    >
      <span className={`live-dot ${behind ? "live-dot-busy" : "live-dot-on"}`} aria-hidden />
      {behind ? "Updating" : refreshedAt === null ? "Live" : clock(refreshedAt)}
    </span>
  );
}
