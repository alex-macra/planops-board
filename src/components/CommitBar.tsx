import { Button, Input } from "../ui/index.tsx";
import { GitBranch, Undo2 } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useState } from "react";

import { ApiError, commit, type GitStatusResponse } from "../api.ts";
import { Notice } from "./Notice.tsx";
import { StatusTag } from "./Tag.tsx";

interface Props {
  readonly git: GitStatusResponse;
  readonly touched: readonly string[];
  readonly undoable: { readonly taskId: string; readonly label: string } | null;
  readonly settling: boolean;
  readonly onUndo: () => void;
  readonly onRefresh: () => Promise<boolean>;
  readonly onCommitted: () => Promise<boolean>;
}

/**
 * Committing is deliberate and never automatic: edits land in the working tree,
 * and this bar is the only thing that creates a commit. Protected or detached
 * sources require a new branch, and pushing stays outside the board entirely.
 */
export function CommitBar({
  git,
  touched,
  undoable,
  settling,
  onUndo,
  onRefresh,
  onCommitted,
}: Props): JSX.Element | null {
  const [message, setMessage] = useState("");
  const [branch, setBranch] = useState(git.suggestedBranch);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [submittedPreviewToken, setSubmittedPreviewToken] = useState<string | null>(null);
  const requiresBranch = git.onProtectedBranch || git.detached;
  const included = git.changedPlanningFiles;
  const excluded = git.otherChangedFiles;
  const canCommit = git.commitEnabled && included.length > 0;
  const previewPending = settling || submittedPreviewToken === git.commitPreviewToken;

  useEffect(() => {
    setBranch(git.suggestedBranch);
  }, [git.branch, git.detached, git.suggestedBranch]);

  if (included.length === 0 && excluded.length === 0) return null;

  async function run(): Promise<void> {
    setBusy(true);
    setFailure(null);
    try {
      await commit({
        taskIds: touched,
        expectedCommitPreviewToken: git.commitPreviewToken,
        ...(message.trim() ? { message } : {}),
        ...(requiresBranch ? { branch } : {}),
      });
      setSubmittedPreviewToken(git.commitPreviewToken);
      setMessage("");
      await onCommitted();
    } catch (error) {
      setFailure(error instanceof ApiError ? error.failure.error : String(error));
      if (error instanceof ApiError && error.failure.kind === "conflict") {
        await onRefresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card space-y-3 p-3" aria-label="Commit changes">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <GitBranch size={15} className="text-ui-text-subtle" />
        <span className="mono text-xs">{git.branch}</span>
        {included.length > 0 ? (
          <StatusTag tone="deferred">
            {included.length} Markdown {included.length === 1 ? "path" : "paths"} included
          </StatusTag>
        ) : null}
        {excluded.length > 0 ? (
          <StatusTag tone="neutral">
            {excluded.length} dirty {excluded.length === 1 ? "path" : "paths"} excluded
          </StatusTag>
        ) : null}
        {canCommit && requiresBranch ? (
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

      <details className="text-xs text-ui-text-subtle">
        <summary className="focus-ring cursor-pointer rounded">Commit preview</summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <div>
            <p className="font-medium text-ui-text">
              Included in this commit ({included.length})
            </p>
            {included.length > 0 ? (
              <ul className="mono mt-1 space-y-0.5">
                {included.map((file) => <li key={file}>{file}</li>)}
              </ul>
            ) : (
              <p className="mt-1">No configured Markdown changes.</p>
            )}
          </div>
          <div>
            <p className="font-medium text-ui-text">
              Left out of this commit ({excluded.length})
            </p>
            {excluded.length > 0 ? (
              <ul className="mono mt-1 space-y-0.5">
                {excluded.map((file) => <li key={file}>{file}</li>)}
              </ul>
            ) : (
              <p className="mt-1">No other dirty paths.</p>
            )}
          </div>
        </div>
        <p className="mt-2 max-w-3xl leading-relaxed">
          This path-level scope was captured at the last refresh. A commit snapshots every current
          change in each included file, including edits made outside the board. Other dirty paths
          are not selected.
        </p>
      </details>

      {canCommit ? <div className="flex flex-wrap items-end gap-2">
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
        <Button
          loading={busy}
          disabled={previewPending || (requiresBranch && branch.trim().length === 0)}
          title={previewPending ? "Waiting for the latest commit preview" : undefined}
          onClick={() => void run()}
        >
          Commit
        </Button>
      </div> : (
        <p className="text-xs text-ui-text-subtle">
          {git.commitEnabled
            ? "No configured Markdown changes to commit."
            : "Commits are disabled by the board configuration."}
        </p>
      )}
    </section>
  );
}
