import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
import {
  attachClosestEdge,
  extractClosestEdge,
  type Edge,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { pointerOutsideOfPreview } from "@atlaskit/pragmatic-drag-and-drop/element/pointer-outside-of-preview";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import { useCallback, useEffect, useRef, useState } from "react";

import { isCardData, isRowData, type CardDragData, type RowDragData } from "./data.ts";

/**
 * The drag preview is a clone of the card rather than a second React root: it is
 * pixel-identical by construction, costs nothing to keep in sync, and the tilt
 * and shadow come from one CSS class.
 */
function clonePreview(element: HTMLElement, className: string) {
  return ({ container }: { container: HTMLElement }): void => {
    const clone = element.cloneNode(true) as HTMLElement;
    clone.classList.add(className);
    clone.style.width = `${element.offsetWidth}px`;
    // A clone carries the original test IDs, so a selector would otherwise
    // match both the card and its drag preview.
    clone.removeAttribute("data-testid");
    for (const descendant of clone.querySelectorAll("[data-testid]")) {
      descendant.removeAttribute("data-testid");
    }
    container.append(clone);
  };
}

export interface DraggableOptions {
  readonly data: Record<string, unknown>;
  readonly canDrag?: boolean;
  readonly previewClass?: string;
}

/** Attach to the element that should be picked up. Returns whether it is in flight. */
export function useDraggableElement<T extends HTMLElement>(
  options: DraggableOptions,
): { readonly ref: React.RefObject<T | null>; readonly dragging: boolean } {
  const ref = useRef<T | null>(null);
  const [dragging, setDragging] = useState(false);
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return draggable({
      element,
      canDrag: () => latest.current.canDrag !== false,
      getInitialData: () => latest.current.data,
      onGenerateDragPreview: ({ nativeSetDragImage }) => {
        setCustomNativeDragPreview({
          nativeSetDragImage,
          getOffset: pointerOutsideOfPreview({ x: "12px", y: "8px" }),
          render: clonePreview(element, latest.current.previewClass ?? "dnd-preview"),
        });
      },
      onDragStart: () => setDragging(true),
      onDrop: () => setDragging(false),
    });
  }, []);

  return { ref, dragging };
}

export type DropState = "idle" | "over" | "blocked";

export interface DropZoneOptions {
  /** Rejecting here refuses the drop at the cursor instead of after a failed write. */
  readonly canDrop: (data: CardDragData) => boolean;
  readonly onDrop: (data: CardDragData) => void;
}

/** A Kanban column, including a collapsed rail. */
export function useCardDropZone<T extends HTMLElement>(
  options: DropZoneOptions,
): { readonly ref: React.RefObject<T | null>; readonly state: DropState } {
  const ref = useRef<T | null>(null);
  const [state, setState] = useState<DropState>("idle");
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return dropTargetForElements({
      element,
      canDrop: ({ source }) => isCardData(source.data),
      // Keep the highlight while the pointer crosses child cards.
      getIsSticky: () => true,
      onDragEnter: ({ source }) => {
        if (!isCardData(source.data)) return;
        setState(latest.current.canDrop(source.data) ? "over" : "blocked");
      },
      onDragLeave: () => setState("idle"),
      onDrop: ({ source }) => {
        setState("idle");
        if (isCardData(source.data) && latest.current.canDrop(source.data)) {
          latest.current.onDrop(source.data);
        }
      },
    });
  }, []);

  return { ref, state };
}

/** Reports whether any card drag is in flight, so the board can show its rails. */
export function useCardDragActive(): boolean {
  const [active, setActive] = useState(false);
  useEffect(
    () =>
      monitorForElements({
        canMonitor: ({ source }) => isCardData(source.data),
        onDragStart: () => setActive(true),
        onDrop: () => setActive(false),
      }),
    [],
  );
  return active;
}

/**
 * Whether *any* drag is in flight, card or Backlog row.
 *
 * `useCardDragActive` is deliberately narrower: the rails it drives are a Kanban
 * affordance and a row reorder must not raise them. Live refresh has to wait for
 * either kind, because replacing the board mid-drag unmounts the element the
 * pointer is holding, so the card is dropped by the app rather than by the user.
 */
export function useDragActive(): boolean {
  const [active, setActive] = useState(false);
  useEffect(
    () =>
      monitorForElements({
        onDragStart: () => setActive(true),
        onDrop: () => setActive(false),
      }),
    [],
  );
  return active;
}

/**
 * Edge-scrolls a scroll container while a card is held near its edge.
 *
 * A callback ref rather than an effect over `ref.current`, because both of this
 * hook's containers mount *after* the component does: a column's body does not
 * exist while the column is a rail, and the Backlog's reorder table only appears
 * once an epic filter is set. An effect with a static dependency list runs once
 * against `null` and never attaches, so exactly the two places that most need
 * edge-scroll silently had none.
 */
export function useAutoScroll<T extends HTMLElement>(
  axis: "horizontal" | "vertical",
): (node: T | null) => void {
  const detach = useRef<(() => void) | null>(null);
  return useCallback(
    (node: T | null) => {
      detach.current?.();
      detach.current = node
        ? autoScrollForElements({ element: node, getAllowedAxis: () => axis })
        : null;
    },
    [axis],
  );
}

export interface RowReorderOptions {
  readonly data: Record<string, unknown>;
  readonly canDrop: (data: RowDragData) => boolean;
  readonly onDrop: (data: RowDragData, edge: Edge) => void;
}

/**
 * A Backlog row: draggable and a drop target at once, with the hitbox helper
 * reporting which half of the row the pointer is on so the insertion line and
 * the resulting Markdown move agree.
 */
export function useReorderableRow<T extends HTMLElement>(
  options: RowReorderOptions,
): {
  readonly ref: React.RefObject<T | null>;
  readonly dragging: boolean;
  readonly edge: Edge | null;
} {
  const ref = useRef<T | null>(null);
  const [dragging, setDragging] = useState(false);
  const [edge, setEdge] = useState<Edge | null>(null);
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return combine(
      draggable({
        element,
        getInitialData: () => latest.current.data,
        onGenerateDragPreview: ({ nativeSetDragImage }) => {
          setCustomNativeDragPreview({
            nativeSetDragImage,
            getOffset: pointerOutsideOfPreview({ x: "12px", y: "8px" }),
            render: clonePreview(element, "dnd-preview-row"),
          });
        },
        onDragStart: () => setDragging(true),
        onDrop: () => setDragging(false),
      }),
      dropTargetForElements({
        element,
        canDrop: ({ source }) => isRowData(source.data) && latest.current.canDrop(source.data),
        getData: ({ input }) =>
          attachClosestEdge(latest.current.data, {
            element,
            input,
            allowedEdges: ["top", "bottom"],
          }),
        onDrag: ({ self, source }) => {
          if (isRowData(source.data) && source.data.taskId === latest.current.data["taskId"]) {
            setEdge(null);
            return;
          }
          setEdge(extractClosestEdge(self.data));
        },
        onDragLeave: () => setEdge(null),
        onDrop: ({ self, source }) => {
          const closest = extractClosestEdge(self.data);
          setEdge(null);
          if (isRowData(source.data) && closest) latest.current.onDrop(source.data, closest);
        },
      }),
    );
  }, []);

  return { ref, dragging, edge };
}

export type { Edge };
