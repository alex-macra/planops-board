// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildBoard } from "../server/ledger/model.ts";
import { toBoardResponse } from "../server/board-response.ts";
import { Backlog } from "../src/views/Backlog.tsx";

const board = toBoardResponse(buildBoard([{
  path: "plans/orbit.md",
  sha256: "a".repeat(64),
  text: [
    "# Orbit",
    "| ID | Priority | Status | Dependencies | Required outcome |",
    "|---|---|---|---|---|",
    "| ORB-001 | P1 | Ready | None | Record the first orbit. |",
    "| ORB-002 | P1 | Ready | None | Record the second orbit. |",
    "| ORB-003 | P2 | Ready | None | Record the third orbit. |",
  ].join("\n"),
}], new Set()));

afterEach(cleanup);

describe("keyboard backlog reorder", () => {
  it("moves a task above or below its adjacent row and disables boundary moves", () => {
    const onReorder = vi.fn();
    render(<Backlog board={board} tasks={board.tasks} onSelectTask={vi.fn()} onReorder={onReorder}
      reorderable lastChanged={{}} />);

    expect(screen.getByRole("button", { name: "Move ORB-001 up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move ORB-003 down" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Move ORB-002 up" }));
    expect(onReorder).toHaveBeenLastCalledWith(board.tasks.find((task) => task.id === "ORB-002"), 4);
    fireEvent.click(screen.getByRole("button", { name: "Move ORB-002 down" }));
    expect(onReorder).toHaveBeenLastCalledWith(board.tasks.find((task) => task.id === "ORB-002"), 6);
  });
});
