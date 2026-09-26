import { Fragment, useEffect, useId, useRef, useState, type JSX, type ReactNode } from "react";
import type { DetailField, Task } from "../api.ts";

const TABS = ["Overview", "Implementation", "Dependencies", "Evidence"] as const;
export type ReaderTab = (typeof TABS)[number];
const OVERVIEW = new Set(["Objective", "Why", "Scope", "Acceptance criteria"]);
const EVIDENCE = new Set(["Readiness", "Verify", "Handoff", "Evidence"]);

interface TaskReaderContentProps {
  readonly active: ReaderTab;
  readonly onChange: (tab: ReaderTab) => void;
  readonly identity: string;
  readonly fields: readonly DetailField[];
  readonly packetMetadata: Task["packetMetadata"];
  readonly renderField: (field: DetailField) => ReactNode;
  readonly evidenceLead?: ReactNode;
  readonly children: ReactNode;
}

function RecordedFilePlan({ plan, index }: { readonly plan: Task["packetMetadata"]["files"][number]; readonly index: number }): JSX.Element {
  return <article className="task-file-plan" aria-label={`Recorded file plan ${index + 1}`}>
    <h4 className="text-sm font-medium">File plan {index + 1}</h4>
    <dl className="task-plan-facts">
      <div><dt>Repository</dt><dd>{plan.repository}</dd></div>
      <div><dt>Path</dt><dd className="mono">{plan.path}</dd></div>
      <div><dt>Recorded state</dt><dd>{plan.state}</dd></div>
      <div><dt>Symbols</dt><dd><ul>{plan.symbols.map((symbol, sourceIndex) =>
        <li key={sourceIndex} className="mono">{symbol}</li>)}</ul></dd></div>
      <div><dt>Intended behavior</dt><dd>{plan.behavior}</dd></div>
      <div><dt>Write boundary</dt><dd>{plan.writeBoundary}</dd></div>
      <div><dt>Proof</dt><dd>{plan.proof}</dd></div>
    </dl>
  </article>;
}

function ImplementationSummary({ metadata }: { readonly metadata: Task["packetMetadata"] }): JSX.Element {
  const id = useId();
  const nonImplementation = metadata.workKind !== null && metadata.workKind !== "implementation";
  const missingLoc = nonImplementation ? "Not applicable" : "Not recorded";
  const loc = metadata.estimatedChangedLoc;
  const estimate = (range: NonNullable<typeof loc>["total"] | undefined) => range === undefined ? missingLoc
    : range.min === range.max ? String(range.min) : `${range.min}-${range.max}`;
  return <section aria-labelledby={`${id}-summary`} className="task-implementation-summary">
    <h3 id={`${id}-summary`} className="text-sm font-medium">Derived implementation summary</h3>
    <p className="text-xs text-ui-text-muted">Summarizes recorded packet data. This is not an audit or a readiness decision.</p>
    <dl className="task-plan-facts">
      <div><dt>Work kind</dt><dd>{metadata.workKind ?? "Not recorded"}</dd></div>
      <div><dt>Production changed LOC</dt><dd>{estimate(loc?.production)}</dd></div>
      <div><dt>Test changed LOC</dt><dd>{estimate(loc?.tests)}</dd></div>
      <div><dt>Total changed LOC</dt><dd>{estimate(loc?.total)}</dd></div>
      <div><dt>Recorded size exception</dt><dd>{metadata.sizeException === null ? "Not recorded"
        : metadata.sizeException === "" ? "Recorded empty value" : metadata.sizeException}</dd></div>
      <div><dt>Parsed split values</dt><dd>{metadata.splitTaskIds.length === 0 ? "Not recorded"
        : <ol aria-label="Parsed split values">{metadata.splitTaskIds.map((value, index) =>
          <li key={index}>{value === "" ? "Recorded empty value" : value}</li>)}</ol>}</dd></div>
    </dl>
    {nonImplementation ? <p className="text-xs text-ui-text-muted">Non-implementation work. Any recorded estimate is shown as supplied.</p> : null}
    {metadata.issues.length > 0 ? <div>
      <h4 className="text-sm font-medium">Packet diagnostics</h4>
      <ul aria-label="Packet diagnostics" className="list-inside list-disc text-sm">
        {metadata.issues.map((issue, index) => <li key={index}>{issue}</li>)}
      </ul>
    </div> : null}
    {metadata.files.length === 0 ? <p className="text-sm text-ui-text-muted">No parsed file plans recorded.</p>
      : metadata.files.map((plan, index) => <RecordedFilePlan key={index} plan={plan} index={index} />)}
  </section>;
}

export function TaskReaderContent({ active, onChange, identity, fields, packetMetadata, renderField, evidenceLead, children }: TaskReaderContentProps): JSX.Element {
  const id = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const [focused, setFocused] = useState<ReaderTab>(active);
  useEffect(() => setFocused(active), [active, identity]);
  const recordedFields = fields.map((field, index) => {
    const section = OVERVIEW.has(field.label) ? "Overview" : EVIDENCE.has(field.label) ? "Evidence" : "Implementation";
    return field.label !== "Note" && section === active ? <Fragment key={index}>{renderField(field)}</Fragment> : null;
  });
  return <>
    <div role="tablist" aria-label="Task content" className="task-reader-tabs">
      {TABS.map((tab, index) => <button key={tab} ref={(node) => { refs.current[index] = node; }}
        type="button" role="tab" id={`${id}-${tab}`} aria-controls={`${id}-panel`}
        aria-selected={active === tab} tabIndex={focused === tab ? 0 : -1}
        className="focus-ring" onFocus={() => setFocused(tab)} onClick={() => onChange(tab)}
        onKeyDown={(event) => {
          const next = event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1
            : event.key === "ArrowRight" ? (index + 1) % TABS.length
              : event.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length : null;
          if (next !== null) { event.preventDefault(); refs.current[next]?.focus(); }
        }}>{tab}</button>)}
    </div>
    <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${active}`} className="space-y-5">
      {active === "Evidence" ? evidenceLead : null}
      {active === "Implementation" ? <ImplementationSummary metadata={packetMetadata} /> : null}
      {active === "Implementation" ? <section aria-labelledby={`${id}-recorded`} className="space-y-5">
        <h3 id={`${id}-recorded`} className="text-sm font-medium">Recorded fields</h3>
        {recordedFields}
      </section> : recordedFields}
      {active === "Overview" ? ["Objective", "Scope", "Acceptance criteria"].filter((label) =>
        !fields.some((field) => field.label === label)).map((label) => <section key={label}>
        <h3 className="text-xs font-medium text-ui-text-muted">{label}</h3><p className="text-sm">Not recorded</p>
      </section>) : null}
      {children}
    </div>
  </>;
}
