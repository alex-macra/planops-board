import { useId, type JSX } from "react";
import type { Board, Task } from "../api.ts";

const DISPATCH_AUDIT: Record<Task["executionReadiness"], string> = {
  ready: "ready",
  blocked: "blocked",
  stale: "stale",
  "no-change": "no change needed",
  unassessed: "not audited",
};

export function ReadinessStates({ task, manifest }: {
  readonly task: Task;
  readonly manifest: Board["qwenReadiness"]["status"];
}): JSX.Element {
  const id = useId();
  const loaded = manifest === "loaded";
  const audit = loaded ? DISPATCH_AUDIT[task.executionReadiness] : `unavailable - readiness manifest ${manifest}`;
  const blockers = loaded ? task.executionBlockers : [];
  return <section aria-labelledby={`${id}-heading`} className="min-w-0 space-y-2 rounded-xl border border-ui-border bg-ui-bg-muted p-3 [overflow-wrap:anywhere]">
    <h3 id={`${id}-heading`} className="text-xs font-medium text-ui-text">Readiness states</h3>
    <p className="text-sm text-ui-text">{`Packet structure: ${task.qwen3CoderNextReady ? "READY" : "not READY"}`}</p>
    <p className="text-sm text-ui-text">{`Dispatch audit: ${audit}`}</p>
    {blockers.length > 0 ? <div>
      <h4 id={`${id}-blockers`} className="text-xs font-medium text-ui-text">Dispatch blockers</h4>
      <ul aria-labelledby={`${id}-blockers`} className="mt-1 list-disc space-y-1 pl-4 text-xs leading-relaxed text-ui-text-muted">
        {blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}
      </ul>
    </div> : null}
  </section>;
}
