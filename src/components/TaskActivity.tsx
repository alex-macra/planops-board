import { Button } from "../ui/index.tsx";
import type { JSX } from "react";
import { useEffect, useState } from "react";

import {
  fetchTaskHistory,
  notesOf,
  type DetailBlock,
  type Task,
  type TaskHistory,
  type Workflow,
} from "../api.ts";
import { messageOf } from "../state.ts";
import { Notice } from "./Notice.tsx";
import { isoDay } from "./relative.ts";
import { StatusTag } from "./Tag.tsx";
import { statusTone } from "./tone.ts";

interface Props {
  readonly task: Task;
  readonly detail: DetailBlock | null;
  readonly workflow: Workflow;
  readonly onAddNote?: ((text: string, title?: string) => Promise<void>) | undefined;
}

/** The timeline is fetched on demand so Git replay stays off the board payload. */
export function TaskActivity({ task, detail, workflow, onAddNote }: Props): JSX.Element {
  const [history, setHistory] = useState<TaskHistory | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setText("");
    setTitle(task.title ?? task.outcome.split(/[.;]/)[0]?.trim().slice(0, 70) ?? "");
  }, [task.file, task.id]);

  useEffect(() => {
    let current = true;
    setHistory(null);
    setFailure(null);
    void fetchTaskHistory(task.file, task.id)
      .then((result) => {
        if (current) setHistory(result);
      })
      .catch((cause: unknown) => {
        if (current) setFailure(messageOf(cause));
      });
    return () => {
      current = false;
    };
  }, [task.file, task.id, task.priority, task.status]);

  const notes = detail ? notesOf(detail) : [];
  const needsTitle = detail === null;

  async function submit(): Promise<void> {
    if (!onAddNote) return;
    setBusy(true);
    setFailure(null);
    try {
      await onAddNote(text, needsTitle ? title : undefined);
      setText("");
    } catch (cause) {
      setFailure(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3">
      <h3 className="text-xs font-medium text-ui-text-muted">Activity</h3>

      {history === null && failure === null ? (
        <p className="text-xs text-ui-text-subtle">Reading the history…</p>
      ) : null}

      {history && history.entries.length === 0 ? (
        <p className="text-xs text-ui-text-subtle">
          No commit has changed this row's status.
        </p>
      ) : null}

      {history && history.entries.length > 0 ? (
        <ol className="space-y-2 border-l border-ui-border pl-3">
          {history.entries.map((entry, index) => (
            <li key={entry.sha ?? `pending-${index}`} className="text-xs">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="tabular text-ui-text-subtle">{isoDay(entry.date)}</span>
                {entry.changed.includes("status") ? (
                  <StatusTag tone={statusTone(entry.status, workflow)}>{entry.status ?? "-"}</StatusTag>
                ) : (
                  <span className="text-ui-text-muted">priority to {entry.priority ?? "-"}</span>
                )}
                {entry.sha === null ? (
                  <span className="text-ui-text-subtle">· not committed</span>
                ) : null}
              </div>
              {entry.subject ? (
                // The commit is shown because it bounds the claim: several of
                // these dates are one commit that landed many documents at once.
                <p className="mt-0.5 text-ui-text-subtle">
                  <span className="mono">{entry.sha?.slice(0, 7)}</span> {entry.subject}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}

      {history ? (
        <p className="text-[11px] text-ui-text-subtle">
          Reconstructed from {history.commitsScanned}{" "}
          {history.commitsScanned === 1 ? "commit" : "commits"} touching{" "}
          <span className="mono">{task.file}</span>; it is only as detailed as they are.
        </p>
      ) : null}

      {notes.length > 0 ? (
        <ul className="space-y-2">
          {notes.map((note, index) => (
            <li key={`${note.date ?? ""}-${index}`} className="rounded-lg bg-ui-bg-muted p-2 text-xs">
              <p className="tabular mb-0.5 text-ui-text-subtle">{note.date ?? "undated"}</p>
              {note.items.map((item, itemIndex) => (
                <p key={itemIndex} className="leading-relaxed text-ui-text">
                  {item}
                </p>
              ))}
            </li>
          ))}
        </ul>
      ) : null}

      {failure ? (
        <Notice tone="blocked" title={failure} onDismiss={() => setFailure(null)}>
          Nothing was written; the document is unchanged.
        </Notice>
      ) : null}

      {onAddNote ? <div className="space-y-2">
        {needsTitle ? (
          <label className="block text-xs">
            <span className="text-ui-text-muted">
              {task.id} has no detail block yet - name it to create one
            </span>
            <input
              className="focus-ring mt-1 w-full rounded-lg border border-ui-border bg-ui-bg px-2 py-1.5 text-sm"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={busy}
              placeholder="Short title for the work item"
              data-testid="note-title"
            />
          </label>
        ) : null}
        <textarea
          className="focus-ring w-full rounded-lg border border-ui-border bg-ui-bg px-2 py-1.5 text-sm"
          rows={3}
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={busy}
          placeholder="Add a note to the Markdown ledger"
          data-testid="note-text"
        />
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          disabled={!text.trim() || (needsTitle && !title.trim())}
          onClick={() => void submit()}
          data-testid="note-save"
        >
          Add note
        </Button>
      </div> : null}
    </section>
  );
}
