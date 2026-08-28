import { Button, Input, Select } from "../ui/index.tsx";
import type { JSX } from "react";
import { useMemo, useState } from "react";

import {
  emptyFilters,
  type BoardQuery,
  type BoardQueryPatch,
  type Filters,
  type GroupBy,
  type ViewId,
} from "../state.ts";

const STORAGE_KEY = "projects-board.saved-views.v1";
const VIEW_IDS = new Set<ViewId>(["now", "stories", "rollup", "kanban", "backlog", "graph"]);
const GROUP_IDS = new Set<GroupBy>(["none", "project", "epic", "repository"]);
const READINESS_IDS = new Set(["", "startable", "waiting", "needs-gate-check"]);

interface SavedView {
  readonly id: string;
  readonly name: string;
  readonly view: ViewId;
  readonly group: GroupBy;
  readonly filters: Filters;
  readonly lastSeenSourceSha: string;
}

function load(): SavedView[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value.slice(0, 20).filter((entry): entry is SavedView => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
      const candidate = entry as Partial<SavedView>;
      const filters = candidate.filters as Partial<Filters> | undefined;
      return (
        typeof candidate.id === "string" &&
        /^[A-Za-z0-9-]{1,64}$/.test(candidate.id) &&
        typeof candidate.name === "string" &&
        candidate.name.length > 0 &&
        candidate.name.length <= 48 &&
        VIEW_IDS.has(candidate.view as ViewId) &&
        GROUP_IDS.has(candidate.group as GroupBy) &&
        typeof candidate.lastSeenSourceSha === "string" &&
        /^[0-9a-f]{40,64}$/.test(candidate.lastSeenSourceSha) &&
        typeof filters === "object" &&
        filters !== null &&
        !Array.isArray(filters) &&
        ["text", "project", "epic", "repository", "priority", "status", "readiness"]
          .every((key) => {
            const value = filters[key as keyof Filters];
            return typeof value === "string" && value.length <= 300;
          }) &&
        READINESS_IDS.has(filters.readiness ?? "")
      );
    });
  } catch {
    return [];
  }
}

function persist(views: readonly SavedView[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(views));
}

interface Props {
  readonly query: BoardQuery;
  readonly sourceSha: string;
  readonly onApply: (patch: BoardQueryPatch) => void;
}

export function SavedViews({ query, sourceSha, onApply }: Props): JSX.Element {
  const [views, setViews] = useState<SavedView[]>(load);
  const [selected, setSelected] = useState("");
  const [editing, setEditing] = useState<"save" | "rename" | null>(null);
  const [name, setName] = useState("");
  const current = useMemo(() => views.find((view) => view.id === selected) ?? null, [views, selected]);

  function store(next: SavedView[]): void {
    setViews(next);
    persist(next);
  }

  function choose(id: string): void {
    setSelected(id);
    setEditing(null);
    if (id === "finish") {
      onApply({ view: "now", group: "none", filters: { ...emptyFilters, project: query.filters.project } });
      return;
    }
    if (id === "active") {
      onApply({
        view: "backlog",
        group: "none",
        filters: { ...emptyFilters, project: query.filters.project, status: "active" },
      });
      return;
    }
    const saved = views.find((view) => view.id === id);
    if (!saved) return;
    onApply({ view: saved.view, group: saved.group, filters: saved.filters, task: null, story: null });
    store(views.map((view) => view.id === id ? { ...view, lastSeenSourceSha: sourceSha } : view));
  }

  function saveName(): void {
    const clean = name.trim().slice(0, 48);
    if (!clean) return;
    if (editing === "rename" && current) {
      store(views.map((view) => view.id === current.id ? { ...view, name: clean } : view));
    } else {
      const id = crypto.randomUUID();
      store([
        ...views,
        {
          id,
          name: clean,
          view: query.view,
          group: query.group,
          filters: query.filters,
          lastSeenSourceSha: sourceSha,
        },
      ].slice(-20));
      setSelected(id);
    }
    setEditing(null);
    setName("");
  }

  return (
    <div className="saved-views" aria-label="Saved views">
      <Select aria-label="Saved view" value={selected} onChange={(event) => choose(event.target.value)}>
        <option value="">Saved views</option>
        <option value="finish">Finish first</option>
        <option value="active">Active work</option>
        {views.map((view) => (
          <option key={view.id} value={view.id}>
            {view.name}{view.lastSeenSourceSha !== sourceSha ? " - source updated" : ""}
          </option>
        ))}
      </Select>
      {editing ? (
        <div className="flex items-center gap-1">
          <Input
            aria-label={editing === "rename" ? "New saved view name" : "Saved view name"}
            value={name}
            maxLength={48}
            onChange={(event) => setName(event.target.value)}
          />
          <Button size="sm" disabled={!name.trim()} onClick={saveName}>Save</Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => { setName(""); setEditing("save"); }}>
            Save current
          </Button>
          {current ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => { setName(current.name); setEditing("rename"); }}>
                Rename
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  store(views.filter((view) => view.id !== current.id));
                  setSelected("");
                }}
              >
                Remove
              </Button>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
