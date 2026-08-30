// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GitStatusResponse } from "../src/api.ts";
import { CommitBar } from "../src/components/CommitBar.tsx";

const TOKEN = "a".repeat(64);

function successfulCommitResponse(): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify({
    branch: "plan/commit-preview",
    sha: "b".repeat(40),
    files: ["plans/example.md"],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

function status(overrides: Partial<GitStatusResponse> = {}): GitStatusResponse {
  return {
    branch: "plan/commit-preview",
    detached: false,
    onProtectedBranch: false,
    commitEnabled: true,
    changedPlanningFiles: ["plans/example.md"],
    otherChangedFiles: [],
    fingerprint: "fixture",
    commitPreviewToken: TOKEN,
    suggestedBranch: "plan/commit-preview",
    ...overrides,
  };
}

function renderCommitBar(
  git: GitStatusResponse,
  overrides: {
    readonly onRefresh?: () => Promise<boolean>;
    readonly onCommitted?: () => Promise<boolean>;
  } = {},
): void {
  render(
    <CommitBar
      git={git}
      touched={[]}
      undoable={null}
      settling={false}
      onUndo={() => undefined}
      onRefresh={overrides.onRefresh ?? (() => Promise.resolve(true))}
      onCommitted={overrides.onCommitted ?? (() => Promise.resolve(true))}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CommitBar", () => {
  it("reveals large commit previews in bounded accessible pages", () => {
    const included = Array.from({ length: 250 }, (_, index) => `plans/included-${index}.md`);
    const excluded = Array.from({ length: 205 }, (_, index) => `excluded-${index}.txt`);
    renderCommitBar(status({ changedPlanningFiles: included, otherChangedFiles: excluded }));

    const includedList = screen.getByRole("list", { name: "included paths" });
    const excludedList = screen.getByRole("list", { name: "excluded paths" });
    expect(within(includedList).getAllByRole("listitem")).toHaveLength(100);
    expect(within(excludedList).getAllByRole("listitem")).toHaveLength(100);
    expect(screen.queryByText("plans/included-100.md")).toBeNull();

    fireEvent.click(screen.getByRole("button", {
      name: "Show 100 more included paths (150 remaining)",
    }));
    expect(within(includedList).getAllByRole("listitem")).toHaveLength(200);
    expect(screen.queryByText("plans/included-200.md")).toBeNull();

    fireEvent.click(screen.getByRole("button", {
      name: "Show 50 more included paths (50 remaining)",
    }));
    expect(within(includedList).getAllByRole("listitem")).toHaveLength(250);
    expect(screen.queryByRole("button", { name: /more included paths/ })).toBeNull();
    expect(within(excludedList).getAllByRole("listitem")).toHaveLength(100);
  });

  it.each([
    {
      name: "transport failure",
      response: () => Promise.reject(new TypeError("Failed to fetch")),
    },
    {
      name: "invalid success response",
      response: () => Promise.resolve(new Response(JSON.stringify({ branch: "missing-fields" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })),
    },
    {
      name: "unknown failure",
      response: () => Promise.reject(new Error("Unexpected client failure")),
    },
  ])("quarantines the preview after an ambiguous $name", async ({ response }) => {
    const onRefresh = vi.fn(() => Promise.resolve(true));
    vi.stubGlobal("fetch", vi.fn(response));
    renderCommitBar(status(), { onRefresh });

    fireEvent.click(screen.getByRole("button", { name: "Commit" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Commit outcome unknown")).toBeTruthy();
    expect(within(alert).getByText(/The commit may have succeeded/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Commit" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Nothing was committed.")).toBeNull();

    fireEvent.click(within(alert).getByRole("button", { name: "Refresh commit preview" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Commit" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("labels an explicit API refusal as not committed without quarantining the preview", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      error: "Git operation is already in progress",
      kind: "git",
    }), {
      status: 409,
      headers: { "content-type": "application/json" },
    }))));
    renderCommitBar(status());

    fireEvent.click(screen.getByRole("button", { name: "Commit" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Nothing was committed.")).toBeTruthy();
    expect(within(alert).queryByRole("button", { name: "Refresh commit preview" })).toBeNull();
    expect((screen.getByRole("button", { name: "Commit" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([
    {
      name: "returns false",
      onCommitted: () => Promise.resolve(false),
    },
    {
      name: "throws",
      onCommitted: () => Promise.reject(new Error("Refresh failed")),
    },
  ])("confirms the commit and quarantines its preview when reload $name", async ({ onCommitted }) => {
    const onRefresh = vi.fn(() => Promise.resolve(true));
    vi.stubGlobal("fetch", vi.fn(successfulCommitResponse));
    renderCommitBar(status(), { onCommitted, onRefresh });

    fireEvent.click(screen.getByRole("button", { name: "Commit" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Commit created")).toBeTruthy();
    expect(within(alert).getByText(/The commit was created, but the board could not refresh/)).toBeTruthy();
    expect(within(alert).queryByText("Commit outcome unknown")).toBeNull();
    expect(within(alert).queryByText("Nothing was committed.")).toBeNull();
    expect((screen.getByRole("button", { name: "Commit" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(alert).getByRole("button", { name: "Refresh commit preview" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Commit" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
