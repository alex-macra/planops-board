import { Input, Modal } from "../ui/index.tsx";
import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { Task } from "../api.ts";
import { findTasks, TASK_JUMP_QUERY_LIMIT, type TaskSearchResult } from "../task-navigation.ts";

interface TaskJumpProps {
  readonly open: boolean;
  readonly tasks: readonly Task[];
  /** Dismissal returns focus to the shell launcher. Opening a result hands focus to its drawer instead. */
  readonly onDismiss: () => void;
  readonly onOpenTask: (taskId: string) => void;
}

function ResultRow({
  result,
  active,
  id,
  onOpen,
}: {
  readonly result: TaskSearchResult;
  readonly active: boolean;
  readonly id: string;
  readonly onOpen: () => void;
}): JSX.Element {
  const { task } = result;
  return (
    <li role="none">
      <button
        id={id}
        role="option"
        type="button"
        disabled={!result.selectable}
        aria-selected={active}
        aria-disabled={!result.selectable}
        className={`focus-ring flex min-h-11 w-full items-start justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
          active ? "bg-ui-accent/[0.1] text-ui-text" : "hover:bg-ui-bg-muted"
        } disabled:cursor-not-allowed disabled:opacity-60`}
        onClick={onOpen}
      >
        <span className="min-w-0">
          <span className="mono block text-sm font-medium">{task.id}</span>
          <span className="block truncate text-xs text-ui-text-muted">
            {task.title ?? task.file}
          </span>
        </span>
        <span className="shrink-0 text-xs text-ui-text-subtle">
          {result.selectable
            ? result.match === "exact-id" ? "exact" : result.match === "id-prefix" ? "ID" : "match"
            : "duplicate ID"}
        </span>
      </button>
    </li>
  );
}

export function TaskJump({ open, tasks, onDismiss, onOpenTask }: TaskJumpProps): JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  const resultsList = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const results = useMemo(() => findTasks(tasks, query), [query, tasks]);
  const selectableIndices = useMemo(
    () => results.flatMap((result, index) => result.selectable ? [index] : []),
    [results],
  );
  const selectedIndex = activeTaskId === null
    ? -1
    : results.findIndex((result) => result.selectable && result.task.id === activeTaskId);
  const activeIndex = activeTaskId === null ? selectableIndices[0] ?? -1 : selectedIndex;
  const activeResult = activeIndex === -1 ? undefined : results[activeIndex];

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => input.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open || activeIndex === -1) return;
    const option = document.getElementById(resultId(activeIndex));
    if (option && resultsList.current?.contains(option)) {
      option.scrollIntoView?.({ block: "nearest" });
    }
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) return;
    const dialog = document.querySelector<HTMLElement>('.task-jump-modal[role="dialog"][aria-modal="true"]');
    const app = document.getElementById("root");
    if (!dialog) return;
    const hadInert = app?.hasAttribute("inert") ?? false;
    const previousAriaHidden = app?.getAttribute("aria-hidden") ?? null;
    app?.setAttribute("inert", "");
    app?.setAttribute("aria-hidden", "true");

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const activeElement = document.activeElement;
      if (event.shiftKey && (activeElement === dialog || activeElement === first || !dialog.contains(activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeElement === last || !dialog.contains(activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (!app) return;
      if (hadInert) app.setAttribute("inert", "");
      else app.removeAttribute("inert");
      if (previousAriaHidden === null) app.removeAttribute("aria-hidden");
      else app.setAttribute("aria-hidden", previousAriaHidden);
    };
  }, [open]);

  const reset = (): void => {
    setQuery("");
    setActiveTaskId(null);
  };
  const dismiss = (): void => {
    reset();
    onDismiss();
  };
  const select = (result: TaskSearchResult | undefined): void => {
    if (!result?.selectable) return;
    reset();
    onOpenTask(result.task.id);
  };
  const selectable = results.filter((result) => result.selectable);
  const resultId = (index: number): string => `task-jump-result-${index}`;
  const moveActive = (direction: -1 | 1): void => {
    if (selectableIndices.length === 0) return;
    const current = selectableIndices.indexOf(activeIndex);
    const next = current === -1
      ? direction === 1 ? 0 : selectableIndices.length - 1
      : Math.min(selectableIndices.length - 1, Math.max(0, current + direction));
    setActiveTaskId(results[selectableIndices[next]!]!.task.id);
  };

  return (
    <Modal open={open} onClose={dismiss} title="Jump to task" size="md" className="task-jump-modal">
      <div className="space-y-3">
        <label className="block space-y-1.5" htmlFor="task-jump-query">
          <span className="text-xs font-medium text-ui-text-muted">Find any canonical task</span>
          <Input
            ref={input}
            id="task-jump-query"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={results.length > 0}
            aria-controls="task-jump-results"
            aria-activedescendant={activeIndex === -1 ? undefined : resultId(activeIndex)}
            value={query}
            maxLength={TASK_JUMP_QUERY_LIMIT}
            placeholder="ID, title, outcome, owner, repository"
            onChange={(event) => {
              setQuery(event.target.value.slice(0, TASK_JUMP_QUERY_LIMIT));
              setActiveTaskId(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveActive(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveActive(-1);
              } else if (event.key === "Enter") {
                event.preventDefault();
                select(activeResult);
              }
            }}
          />
        </label>

        {query.trim() && results.length === 0 ? (
          <p role="status" className="text-sm text-ui-text-muted">
            No current task matches that search.
          </p>
        ) : null}
        {query.trim() && results.length > 0 && selectable.length === 0 ? (
          <p role="status" className="text-sm text-ui-danger">
            This ID is duplicated in the planning corpus, so it cannot be opened here.
          </p>
        ) : null}
        {results.length > 0 ? (
          <ul ref={resultsList} id="task-jump-results" role="listbox" aria-label="Task search results" className="max-h-80 space-y-1 overflow-y-auto">
            {results.map((result, index) => (
              <ResultRow
                key={`${result.task.id}-${result.task.file}-${result.task.line}`}
                result={result}
                active={index === activeIndex}
                id={resultId(index)}
                onOpen={() => select(result)}
              />
            ))}
          </ul>
        ) : null}
        <p className="text-xs text-ui-text-subtle">
          Search stays in this dialog and is never sent to the server or saved in the URL.
        </p>
      </div>
    </Modal>
  );
}
