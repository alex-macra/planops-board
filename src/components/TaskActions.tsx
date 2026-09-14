import { MoreHorizontal } from "lucide-react";
import type { JSX } from "react";
import { DropdownMenu, type DropdownGroup } from "../ui/index.tsx";

interface Props {
  readonly taskId: string;
  readonly onOpenDetails: () => void;
  readonly onOpenGraph?: () => void;
  readonly onShowInBacklog?: () => void;
  readonly extraGroups?: readonly DropdownGroup[];
}

export function TaskActions({ taskId, onOpenDetails, onOpenGraph, onShowInBacklog, extraGroups = [] }: Props): JSX.Element {
  return (
    <DropdownMenu
      align="end"
      triggerLabel={`Actions for ${taskId}`}
      trigger={<span className="task-actions-icon"><MoreHorizontal size={16} aria-hidden /></span>}
      groups={[
        {
          label: taskId,
          items: [
            { id: "open", label: "Open task details", onClick: onOpenDetails },
            ...(onOpenGraph ? [{ id: "graph", label: "Show dependencies", onClick: onOpenGraph }] : []),
            ...(onShowInBacklog ? [{ id: "backlog", label: "Find in backlog", onClick: onShowInBacklog }] : []),
          ],
        },
        ...extraGroups,
      ]}
    />
  );
}
