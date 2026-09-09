// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { toBoardResponse } from "../server/board-response.ts";
import { buildBoard } from "../server/ledger/model.ts";
import { TaskDrawer } from "../src/components/TaskDrawer.tsx";
import { Drawer } from "../src/ui/index.tsx";

vi.mock("../src/components/TaskActivity.tsx", () => ({ TaskActivity: ({ render }: {
  render?: (activity: React.JSX.Element) => React.JSX.Element | null;
}) => render ? render(<></>) : null }));

const board = toBoardResponse(buildBoard([{
  path: "plans/orbit.md",
  sha256: "a".repeat(64),
  text: [
    "# Orbital observatory",
    "| ID | Priority | Status | Dependencies | Required outcome |",
    "|---|---|---|---|---|",
    "| ORB-001 | P1 | Complete | None | Preserve the reference orbit. |",
    "| ORB-002 | P1 | Ready | ORB-001 | Compare the next observation. |",
    "### ORB-001 - Reference orbit",
    "- **Scope:** Preserve the original observation.",
    "### ORB-002 - Compare observations",
    "- **Scope:** Compare the new observation with `ORB-001`.",
  ].join("\n"),
}], new Set(), [], "2026-08-20T12:00:00.000Z"));

const props = {
  board,
  onClose: vi.fn(),
  onSelectTask: vi.fn(),
  onOpenGraph: vi.fn(),
  sourceRef: "refs/heads/main",
  sourceSha: "a".repeat(40),
  mode: { kind: "viewer" } as const,
};

afterEach(() => {
  cleanup();
  document.body.style.removeProperty("overflow");
  vi.clearAllMocks();
});

describe("task reader width", () => {
  it("defaults to 60 percent and offers only the approved presets", () => {
    render(<TaskDrawer {...props} task={board.tasks[1]!} />);
    const width = screen.getByRole("combobox", { name: "Reader width" });
    expect(width).toHaveValue("60");
    expect(within(width).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "50%", "60%", "75%", "Full",
    ]);
  });

  it("retains the chosen width when a related task replaces the current task", () => {
    const { rerender } = render(<TaskDrawer {...props} task={board.tasks[1]!} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Reader width" }), { target: { value: "75" } });
    fireEvent.click(screen.getAllByRole("button", { name: "ORB-001" })[0]!);
    expect(props.onSelectTask).toHaveBeenCalledWith("ORB-001");
    rerender(<TaskDrawer {...props} task={board.tasks[0]!} />);
    expect(screen.getByRole("combobox", { name: "Reader width" })).toHaveValue("75");
    expect(screen.getByRole("dialog", { name: "ORB-001 - Reference orbit" })).toBeVisible();
  });

  it("resizes without changing task data or invoking edit actions", () => {
    const before = JSON.stringify(board);
    const mode = { kind: "local", onSaveStatus: vi.fn(), onSavePriority: vi.fn(), onAddNote: vi.fn() } as const;
    render(<TaskDrawer {...props} mode={mode} task={board.tasks[1]!} />);
    for (const value of ["50", "60", "75", "100"]) {
      fireEvent.change(screen.getByRole("combobox", { name: "Reader width" }), { target: { value } });
    }
    expect(JSON.stringify(board)).toBe(before);
    expect(mode.onSaveStatus).not.toHaveBeenCalled();
    expect(mode.onSavePriority).not.toHaveBeenCalled();
    expect(mode.onAddNote).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "Base state" })).toBeEnabled();
  });

  it.each([["", ""], ["scroll", "important"]] as const)(
    "restores the prior inline body overflow %s after the reader closes",
    (overflow, priority) => {
      document.body.style.setProperty("overflow", overflow, priority);
      const { rerender } = render(<TaskDrawer {...props} task={board.tasks[1]!} />);
      expect(document.body.style.overflow).toBe("hidden");
      rerender(<TaskDrawer {...props} task={null} />);
      expect(document.body.style.getPropertyValue("overflow")).toBe(overflow);
      expect(document.body.style.getPropertyPriority("overflow")).toBe(priority);
    },
  );

  it("restores body scrolling when the task reader unmounts", () => {
    document.body.style.overflow = "auto";
    const { unmount } = render(<TaskDrawer {...props} task={board.tasks[1]!} />);
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("auto");
  });

  it.each([["sm", "w-72"], ["md", "w-80"], ["lg", "w-96"], ["xl", "w-[28rem]"]] as const)(
    "preserves the %s non-task drawer size",
    (size, width) => {
      render(<Drawer open onClose={vi.fn()} title="Other panel" size={size}>Other content</Drawer>);
      expect(screen.getByRole("dialog")).toHaveClass(width);
      expect(screen.getByRole("dialog")).not.toHaveClass("task-reader");
      expect(document.body.style.overflow).toBe("");
    },
  );

  it("keeps hidden descendants out of the modal focus loop", () => {
    render(
      <Drawer open onClose={vi.fn()} title="Focus example">
        <button type="button">Visible action</button>
        <section hidden><button type="button">Hidden action</button></section>
      </Drawer>,
    );
    screen.getByRole("button", { name: "Visible action" }).focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });

  it("reaches a collapsed disclosure summary without including its hidden controls", () => {
    render(
      <Drawer open onClose={vi.fn()} title="Focus example">
        <button type="button">Last action</button>
        <details>
          <summary>Other columns</summary>
          <button type="button">Hidden action</button>
          <details><summary>Hidden nested disclosure</summary></details>
        </details>
      </Drawer>,
    );
    screen.getByRole("button", { name: "Last action" }).focus();
    expect(fireEvent.keyDown(document, { key: "Tab" })).toBe(true);
    screen.getByText("Other columns").focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(screen.getByText("Other columns")).toHaveFocus();
  });

  it("includes controls inside an expanded disclosure in the focus loop", () => {
    render(
      <Drawer open onClose={vi.fn()} title="Focus example">
        <details open>
          <summary>Other columns</summary>
          <button type="button">Expanded action</button>
        </details>
      </Drawer>,
    );
    screen.getByRole("button", { name: "Close" }).focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Expanded action" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });

  it.each([-1, -2])("excludes tabIndex %s tabs from a static viewer focus cycle", (tabIndex) => {
    render(
      <Drawer open onClose={vi.fn()} title="Static viewer" size="reader">
        <div role="tablist" aria-label="Task content">
          <button type="button" role="tab" aria-selected tabIndex={0}>Overview</button>
          <button type="button" role="tab" aria-selected={false} tabIndex={tabIndex}>Implementation</button>
          <button type="button" role="tab" aria-selected={false} tabIndex={tabIndex}>Dependencies</button>
          <button type="button" role="tab" aria-selected={false} tabIndex={tabIndex}>Evidence</button>
        </div>
        <section role="tabpanel" aria-label="Overview">A read-only task brief.</section>
      </Drawer>,
    );
    const overview = screen.getByRole("tab", { name: "Overview" });
    const heading = screen.getByRole("heading", { name: "Static viewer" });
    overview.focus();
    expect(fireEvent.keyDown(document, { key: "Tab" })).toBe(false);
    expect(heading).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(overview).toHaveFocus();
  });

  it.each([undefined, 0, 2])("preserves the normal focus cycle for tabIndex %s controls", (tabIndex) => {
    render(
      <Drawer open onClose={vi.fn()} showHeader={false} ariaLabel="Normal focus cycle">
        <button type="button" tabIndex={tabIndex}>First action</button>
        <button type="button" tabIndex={tabIndex}>Last action</button>
      </Drawer>,
    );
    const first = screen.getByRole("button", { name: "First action" });
    const last = screen.getByRole("button", { name: "Last action" });
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });
});
