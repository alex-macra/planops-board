import type { SourceTracking } from "../shared/contracts.ts";
import type { LiveStatus } from "./live.ts";

export function sourceFreshnessLabel(options: {
  readonly behind: boolean;
  readonly live: LiveStatus;
  readonly readOnly: boolean;
  readonly tracking: SourceTracking | null;
}): string {
  if (options.behind) return "Snapshot stale; refresh pending";
  if (options.tracking) {
    const name = options.tracking.ref.replace(/^refs\/remotes\//, "");
    if (options.tracking.relation === "behind") return `Read clone is behind fetched ${name}`;
    if (options.tracking.relation === "ahead") return `Read clone is ahead of fetched ${name}`;
    if (options.tracking.relation === "diverged") return `Read clone diverges from fetched ${name}`;
    if (options.tracking.relation === "unavailable") return `Fetched ${name} is unavailable; freshness not confirmed`;
    return options.live === "live"
      ? `Snapshot matches fetched ${name}`
      : `Matches fetched ${name}; watcher freshness not confirmed`;
  }
  if (options.readOnly) return "Tracking ref not configured; freshness not confirmed";
  return options.live === "live" ? "Snapshot current at local source" : "Freshness not confirmed";
}
