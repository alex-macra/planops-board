import { EmptyState, SegmentedControl, Spinner } from "../ui/index.tsx";
import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";

import type { Board, Task } from "../api.ts";
import { Tag } from "../components/Tag.tsx";
import { buildDependencyGraph } from "../dependency-graph.ts";

interface Props {
  readonly board: Board;
  readonly tasks: readonly Task[];
  readonly selectedId: string | null;
  readonly onSelectTask: (taskId: string) => void;
}

const NODE_WIDTH = 190;
const NODE_HEIGHT = 46;

/**
 * Project tints are assigned by position so adding a project does not require
 * choosing a colour.
 *
 * The values live in `styles.css` as `--proj-*` so they follow light and dark
 * with everything else through the same token indirection used for
 * `--ui-*`. They are held to roughly one lightness and separated by hue rather
 * than by saturation, so no single project shouts and the set survives a colour
 * vision deficiency.
 */
const PROJECT_COLOURS = Array.from({ length: 10 }, (_, index) => `rgb(var(--proj-${index + 1}))`);

const elk = new ELK();

interface Placed {
  readonly id: string;
  readonly task: Task;
  readonly x: number;
  readonly y: number;
}

interface Edge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly gate: string | null;
  readonly actionable: boolean;
  readonly crossProject: boolean;
  readonly points: { x: number; y: number }[];
}

interface Layout {
  readonly nodes: Placed[];
  readonly edges: Edge[];
  readonly width: number;
  readonly height: number;
}

export function Graph({ board, tasks, selectedId, onSelectTask }: Props): JSX.Element {
  const [layout, setLayout] = useState<Layout | null>(null);
  const [busy, setBusy] = useState(true);
  // A whole-plan graph is far wider than most screens; fit by default so
  // the shape of the programme is legible, and let the user zoom in to read.
  const [fit, setFit] = useState(true);

  // The graph must retain canonical duplicate-ID knowledge even when the
  // active filter hides one of the duplicate rows. Filters only decide which
  // already-classified nodes are visible.
  const graph = useMemo(() => buildDependencyGraph(board.tasks, board.workflow), [board.tasks, board.workflow]);

  // Only tasks that participate in a dependency relationship among the current
  // filter selection; isolated nodes would be noise in a DAG.
  const connected = useMemo(() => {
    const visible = new Set(tasks.map((task) => task.id));
    const ids = new Set<string>();
    for (const edge of graph.displayEdges) {
      if (!visible.has(edge.prerequisite.id) || !visible.has(edge.dependant.id)) continue;
      ids.add(edge.prerequisite.id);
      ids.add(edge.dependant.id);
    }
    return tasks.filter((task) => ids.has(task.id) && graph.tasksById.has(task.id));
  }, [graph, tasks]);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);

    const visible = new Set(connected.map((task) => task.id));
    const visibleEdges = graph.displayEdges.filter(
      (edge) => visible.has(edge.prerequisite.id) && visible.has(edge.dependant.id),
    );
    const edgeMeta = new Map(
      visibleEdges.map((edge) => [`${edge.prerequisite.id}->${edge.dependant.id}`, edge]),
    );
    const layoutGraph: ElkNode = {
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.layered.spacing.nodeNodeBetweenLayers": "70",
        "elk.spacing.nodeNode": "18",
        "elk.edgeRouting": "POLYLINE",
        // A full graph can have many disconnected groups. Pack them into a
        // square-ish area instead of stacking them down a very tall page.
        "elk.separateConnectedComponents": "true",
        "elk.spacing.componentComponent": "40",
        "elk.aspectRatio": "2.2",
      },
      children: connected.map((task) => ({
        id: task.id,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      })),
      edges: visibleEdges.map((edge) => ({
        id: `${edge.prerequisite.id}->${edge.dependant.id}`,
        sources: [edge.prerequisite.id],
        targets: [edge.dependant.id],
      })),
    };

    void elk
      .layout(layoutGraph)
      .then((result) => {
        if (cancelled) return;
        const nodes: Placed[] =
          result.children?.flatMap((child) => {
            const task = graph.tasksById.get(child.id);
            return task ? [{ id: child.id, task, x: child.x ?? 0, y: child.y ?? 0 }] : [];
          }) ?? [];

        const edges: Edge[] =
          result.edges?.flatMap((edge) => {
            const [from] = edge.sources ?? [];
            const [to] = edge.targets ?? [];
            if (!from || !to) return [];
            const target = graph.tasksById.get(to);
            const meta = edgeMeta.get(edge.id);
            const section = edge.sections?.[0];
            const points = section
              ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]
              : [];
            return [
              {
                id: edge.id,
                from,
                to,
                gate: meta?.gate ?? null,
                actionable: meta?.actionable ?? false,
                crossProject: graph.tasksById.get(from)?.project !== target?.project,
                points,
              },
            ];
          }) ?? [];

        setLayout({
          nodes,
          edges,
          width: result.width ?? 0,
          height: result.height ?? 0,
        });
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [connected, graph]);

  const highlighted = useMemo(
    () => (selectedId ? graph.upstreamOf(selectedId) : new Set<string>()),
    [graph, selectedId],
  );

  const colourOf = useMemo(() => {
    const index = new Map(board.projects.map((project, position) => [project.id, position]));
    return (projectId: string): string =>
      PROJECT_COLOURS[(index.get(projectId) ?? 0) % PROJECT_COLOURS.length]!;
  }, [board]);

  const legend = useMemo(() => {
    const present = new Set(layout?.nodes.map((node) => node.task.project) ?? []);
    return board.projects.filter((project) => present.has(project.id));
  }, [board, layout]);

  if (busy && !layout) {
    return (
      <div className="flex justify-center p-12">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!layout || layout.nodes.length === 0) {
    return (
      <EmptyState
        title="No dependency edges in this selection"
        description="Widen the filters - dependencies are declared in each document."
      />
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-xs text-ui-text-subtle">
        <span>
          {layout.nodes.length} nodes · {layout.edges.length} edges
        </span>
        <SegmentedControl
          size="sm"
          ariaLabel="Graph zoom"
          value={fit ? "fit" : "full"}
          onChange={(next) => setFit(next === "fit")}
          options={[
            { value: "fit", label: "Fit" },
            { value: "full", label: "100%" },
          ]}
        />
        <span className="flex items-center gap-1">
          <svg width="22" height="8" aria-hidden>
            <line
              x1="0"
              y1="4"
              x2="22"
              y2="4"
              stroke="rgb(var(--ui-danger))"
              strokeWidth="2"
              strokeDasharray="4 3"
            />
          </svg>
          crosses projects
        </span>
        <span className="flex items-center gap-1">
          <svg width="22" height="8" aria-hidden>
            <line
              x1="0"
              y1="4"
              x2="22"
              y2="4"
              stroke="rgb(var(--ui-danger))"
              strokeWidth="1.5"
              strokeDasharray="2 3"
            />
          </svg>
          needs gate check
        </span>
        {selectedId ? (
          <Tag tone="progress">
            {highlighted.size} task(s) block {selectedId}
          </Tag>
        ) : (
          <span>Select a node to highlight everything it waits on.</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs text-ui-text-subtle">
        {legend.map((project) => (
          <span key={project.id} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: colourOf(project.id) }}
              aria-hidden
            />
            {project.label}
          </span>
        ))}
      </div>

      <div className="overflow-auto rounded-xl border border-ui-border bg-ui-bg-raised p-2">
        <svg
          width={fit ? "100%" : layout.width + 40}
          height={
            fit
              ? Math.min(760, ((layout.height + 40) / (layout.width + 40)) * 1400)
              : layout.height + 40
          }
          viewBox={fit ? `0 0 ${layout.width + 40} ${layout.height + 40}` : undefined}
          preserveAspectRatio={fit ? "xMidYMid meet" : undefined}
          role="img"
          aria-label="Task dependency graph"
        >
          <defs>
            <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
              <path d="M0,0 L0,6 L7,3 z" fill="rgb(var(--ui-text-subtle))" />
            </marker>
          </defs>
          <g transform="translate(20,20)">
            {layout.edges.map((edge) => {
              const active = selectedId !== null && (edge.to === selectedId || highlighted.has(edge.to));
              return (
                <g key={edge.id}>
                  <polyline
                    points={edge.points.map((point) => `${point.x},${point.y}`).join(" ")}
                    fill="none"
                    stroke={
                      active
                        ? "rgb(var(--ui-accent))"
                        : !edge.actionable || edge.crossProject
                          ? "rgb(var(--ui-danger))"
                          : "rgb(var(--ui-border))"
                    }
                    strokeWidth={active ? 2 : !edge.actionable || edge.crossProject ? 1.75 : 1.25}
                    strokeDasharray={!edge.actionable ? "2 3" : edge.crossProject ? "4 3" : undefined}
                    markerEnd="url(#arrow)"
                  />
                  {(edge.gate || !edge.actionable) && edge.points.length > 0 ? (
                    <text
                      x={edge.points[Math.floor(edge.points.length / 2)]!.x}
                      y={edge.points[Math.floor(edge.points.length / 2)]!.y - 4}
                      className="mono"
                      fontSize="9"
                      fill="rgb(var(--ui-text-subtle))"
                    >
                      {edge.gate ? `@${edge.gate}` : "check"}
                    </text>
                  ) : null}
                </g>
              );
            })}

            {layout.nodes.map((node) => {
              const isSelected = node.id === selectedId;
              const isBlocker = highlighted.has(node.id);
              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x},${node.y})`}
                  className="graph-node cursor-pointer"
                  role="button"
                  tabIndex={0}
                  aria-label={`Open ${node.id}: ${node.task.title ?? node.task.outcome}`}
                  onClick={() => onSelectTask(node.id)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onSelectTask(node.id);
                  }}
                >
                  <rect
                    width={NODE_WIDTH}
                    height={NODE_HEIGHT}
                    rx="8"
                    fill="rgb(var(--ui-bg-raised))"
                    stroke={
                      isSelected
                        ? "rgb(var(--ui-accent))"
                        : isBlocker
                          ? "rgb(var(--ui-danger))"
                          : "rgb(var(--ui-border))"
                    }
                    strokeWidth={isSelected || isBlocker ? 2 : 1}
                  />
                  {/* Which product this row belongs to, readable without a click. */}
                  <rect
                    width="4"
                    height={NODE_HEIGHT - 12}
                    x="1"
                    y="6"
                    rx="2"
                    fill={colourOf(node.task.project)}
                  />
                  <text x="12" y="19" fontSize="11" className="mono" fill="rgb(var(--ui-text))">
                    {node.id.length > 26 ? `${node.id.slice(0, 25)}…` : node.id}
                  </text>
                  <text x="12" y="34" fontSize="10" fill="rgb(var(--ui-text-subtle))">
                    {node.task.statusBase ?? "-"}
                    {node.task.priority ? ` · ${node.task.priority}` : ""}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}
