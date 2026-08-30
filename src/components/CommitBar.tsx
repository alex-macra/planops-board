import { Button, Input } from "../ui/index.tsx";
import { GitBranch, Undo2 } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useId, useState } from "react";

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

interface PreviewPathsProps {
  readonly paths: readonly string[];
  readonly scope: "included" | "excluded";
}

type CommitFailure =
  | { readonly outcome: "refused"; readonly message: string }
  | { readonly outcome: "unknown"; readonly message: string; readonly previewToken: string }
  | { readonly outcome: "created"; readonly previewToken: string };

const PATH_PAGE_SIZE = 100;

function PreviewPaths({ paths, scope }: PreviewPathsProps): JSX.Element {
  const [visibleCount, setVisibleCount] = useState(PATH_PAGE_SIZE);
  const listId = useId();
  const visiblePaths = paths.slice(0, visibleCount);
  const remaining = Math.max(0, paths.length - visiblePaths.length);

  useEffect(() => {
    setVisibleCount(PATH_PAGE_SIZE);
  }, [paths]);

  return (
    <>
      <ul id={listId} aria-label={`${scope} paths`} className="mono mt-1 space-y-0.5">
        {visiblePaths.map((file) => <li key={file}>{file}</li>)}
      </ul>
      {remaining > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1"
          aria-controls={listId}
          onClick={() => setVisibleCount((current) => current + PATH_PAGE_SIZE)}
        >
          Show {Math.min(PATH_PAGE_SIZE, remaining)} more {scope} paths ({remaining} remaining)
        </Button>
      ) : null}
    </>
  );
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
  const [refreshing, setRefreshing] = useState(false);
  const [failure, setFailure] = useState<CommitFailure | null>(null);
  const [submittedPreviewToken, setSubmittedPreviewToken] = useState<string | null>(null);
  const requiresBranch = git.onProtectedBranch || git.detached;
  const included = git.changedPlanningFiles;
  const excluded = git.otherChangedFiles;
  const canCommit = git.commitEnabled && included.length > 0;
  const previewQuarantined = failure !== null
    && failure.outcome !== "refused"
    && failure.previewToken === git.commitPreviewToken;
  const previewPending = settling
    || submittedPreviewToken === git.commitPreviewToken
    || previewQuarantined;

  useEffect(() => {
    setBranch(git.suggestedBranch);
  }, [git.branch, git.detached, git.suggestedBranch]);

  useEffect(() => {
    setFailure((current) => current !== null
      && current.outcome !== "refused"
      && current.previewToken !== git.commitPreviewToken ? null : current);
    setSubmittedPreviewToken((current) => current !== null
      && current !== git.commitPreviewToken ? null : current);
  }, [git.commitPreviewToken]);

  if (included.length === 0 && excluded.length === 0) return null;

  async function refreshPreview(): Promise<boolean> {
    try {
      return await onRefresh();
    } catch {
      return false;
    }
  }

  async function run(): Promise<void> {
    setBusy(true);
    setFailure(null);
    try {
      try {
        await commit({
          taskIds: touched,
          expectedCommitPreviewToken: git.commitPreviewToken,
          ...(message.trim() ? { message } : {}),
          ...(requiresBranch ? { branch } : {}),
        });
      } catch (error) {
        const refused = error instanceof ApiError && error.failure.kind !== undefined;
        const errorMessage = error instanceof ApiError ? error.failure.error : String(error);
        setFailure(refused
          ? { outcome: "refused", message: errorMessage }
          : { outcome: "unknown", message: errorMessage, previewToken: git.commitPreviewToken });
        if (refused && error.failure.kind === "conflict") {
          await refreshPreview();
        }
        return;
      }

      setSubmittedPreviewToken(git.commitPreviewToken);
      setMessage("");
      let refreshed = false;
      try {
        refreshed = await onCommitted();
      } catch {
        refreshed = false;
      }
      if (refreshed) {
        setSubmittedPreviewToken(null);
      } else {
        setFailure({ outcome: "created", previewToken: git.commitPreviewToken });
      }
    } finally {
      setBusy(false);
    }
  }

  async function refreshQuarantinedPreview(): Promise<void> {
    setRefreshing(true);
    try {
      if (await refreshPreview()) {
        setFailure(null);
        setSubmittedPreviewToken(null);
      }
    } finally {
      setRefreshing(false);
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
        <Notice
          tone={failure.outcome === "created" ? "done" : "blocked"}
          title={failure.outcome === "unknown"
            ? "Commit outcome unknown"
            : failure.outcome === "created" ? "Commit created" : failure.message}
          onDismiss={failure.outcome === "refused" ? () => setFailure(null) : undefined}
        >
          {failure.outcome === "refused" ? (
            "Nothing was committed."
          ) : (
            <>
              {failure.outcome === "unknown" ? (
                <>
                  <p>{failure.message}</p>
                  <p>The commit may have succeeded. Refresh the commit preview before trying again.</p>
                </>
              ) : (
                <p>The commit was created, but the board could not refresh. Refresh the commit preview before continuing.</p>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="mt-1"
                loading={refreshing}
                onClick={() => void refreshQuarantinedPreview()}
              >
                Refresh commit preview
              </Button>
            </>
          )}
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
              <PreviewPaths paths={included} scope="included" />
            ) : (
              <p className="mt-1">No configured Markdown changes.</p>
            )}
          </div>
          <div>
            <p className="font-medium text-ui-text">
              Left out of this commit ({excluded.length})
            </p>
            {excluded.length > 0 ? (
              <PreviewPaths paths={excluded} scope="excluded" />
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
          title={previewQuarantined
            ? "Refresh the commit preview before retrying"
            : previewPending ? "Waiting for the latest commit preview" : undefined}
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
