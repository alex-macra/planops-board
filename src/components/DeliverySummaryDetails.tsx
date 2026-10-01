import type { JSX } from "react";

import type { Task } from "../api.ts";
import { KV } from "../ui/index.tsx";

export function DeliverySummaryDetails({ summary }: {
  readonly summary: NonNullable<Task["deliverySummary"]>;
}): JSX.Element {
  return (
    <section role="region" aria-label="Delivery summary" className="space-y-2 rounded-xl border border-ui-border bg-ui-bg-muted p-3">
      <h3 className="text-xs font-medium text-ui-text">Delivery summary</h3>
      <div className="kv-quiet text-sm">
        <KV k="Run" v={<span className="mono break-all text-xs">{summary.runId}</span>} />
        <KV k="Executor" v={summary.executor} />
        <KV k="Phase" v={summary.phase} />
        <KV k="Outcome" v={summary.outcome} />
        <KV k="Next gate" v={summary.nextGate ?? "No next gate recorded"} />
        <KV k="Product revision" v={<span className="mono break-all text-xs">{summary.productRevision}</span>} />
        <KV k="Updated" v={<time dateTime={summary.updatedAt}>{new Date(summary.updatedAt).toLocaleString()}</time>} />
      </div>
      <div>
        <h4 className="text-xs font-medium text-ui-text-muted">Evidence references</h4>
        {summary.evidence.length > 0 ? (
          <ul className="mt-1 list-inside list-disc break-all text-xs leading-relaxed text-ui-text-muted">
            {summary.evidence.map((reference, index) => <li key={`${index}-${reference}`}>{reference}</li>)}
          </ul>
        ) : <p className="mt-1 text-xs text-ui-text-subtle">No evidence references recorded.</p>}
      </div>
    </section>
  );
}
