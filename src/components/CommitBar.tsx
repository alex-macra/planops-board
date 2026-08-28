import { Button, Input } from "../ui/index.tsx";
import { GitBranch, Undo2 } from "lucide-react";
import type { JSX } from "react";
import { useState } from "react";

import { ApiError, commit, type GitStatusResponse } from "../api.ts";
import { Notice } from "./Notice.tsx";
import { StatusTag } from "./Tag.tsx";

interface Props {
  readonly git: GitStatusResponse;
  readonly touched: readonly string[];
  readonly undoable: { readonly taskId: string; readonly label: string } | null;
  readonly onUndo: () => void;
  readonly onCommitted: () => void;
}

/**
 * Committing is deliberate and never automatic: edits land in the working tree,
 * and this bar is the only thing that creates a commit. Protected or detached
 * sources require a new branch, and pushing stays outside the board entirely.
 */
export function CommitBar({ git, touched, undoable, onUndo, onCommitted }: Props): JSX.Element | null {
  const [message, setMessage] = useState("");
  const [branch, setBranch] = useState(git.suggestedBranch);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const requiresBranch = git.onProtectedBranch || git.detached;

  if (git.changedPlanningFiles.length === 0) return null;

  async function run(): Promise<void> {
    setBusy(true);
    setFailure(null);
    try {
      await commit({
        taskIds: touched,
        ...(message.trim() ? { message } : {}),
        ...(requiresBranch ? { branch } : {}),
      });
      setMessage("");
      onCommitted();
    } catch (error) {
      setFailure(error instanceof ApiError ? error.failure.error : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-2 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <GitBranch size={15} className="text-ui-text-subtle" />
        <span className="mono text-xs">{git.branch}</span>
        <StatusTag tone="deferred">
          {git.changedPlanningFiles.length} planning file(s) modified
        </StatusTag>
        {requiresBranch ? (
          <StatusTag tone="blocked">
            {git.detached ? "detached HEAD" : "protected branch"} - a new branch is required
          </StatusTag>
        ) : null}
        {undoable ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<Undo2 size={14} />}
            onClick={onUndo}
            title={`Restore ${undoable.label}`}
          >
            Undo {undoable.taskId}
          </Button>
        ) : null}
      </div>

      {failure ? (
        <Notice tone="blocked" title={failure} onDismiss={() => setFailure(null)}>
          Nothing was committed.
        </Notice>
      ) : null}

      <div className="flex flex-wrap items-end gap-2">
        {requiresBranch ? (
          <label className="text-xs">
            <span className="text-ui-text-subtle">New branch</span>
            <Input value={branch} onChange={(event) => setBranch(event.target.value)} />
          </label>
        ) : null}
        <label className="min-w-64 flex-1 text-xs">
          <span className="text-ui-text-subtle">Commit message (optional)</span>
          <Input
            value={message}
            placeholder={
              touched.length > 0
                ? `Update ${touched.slice(0, 3).join(", ")}… from the planning board`
                : "Update planning ledgers from the board"
            }
            onChange={(event) => setMessage(event.target.value)}
          />
        </label>
        <Button loading={busy} disabled={requiresBranch && branch.trim().length === 0} onClick={() => void run()}>
          Commit
        </Button>
      </div>

      <details className="text-xs text-ui-text-subtle">
        <summary className="cursor-pointer">Files that will be staged</summary>
        <ul className="mono mt-1 space-y-0.5">
          {git.changedPlanningFiles.map((file) => (
            <li key={file}>{file}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
