import { expect, test, type Locator } from "@playwright/test";
import { boardSchema } from "../shared/contracts.ts";

import { resetBrowserRepository } from "./fixture.ts";

test.setTimeout(60_000);

test.beforeEach(async () => {
  await resetBrowserRepository();
});

test("edits, undoes, annotates, branches, and commits a fictional task", async ({ page }) => {
  const foreign = await page.request.get("/api/session", {
    headers: { Origin: "https://example.invalid" },
  });
  expect(foreign.status()).toBe(403);

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "PlanOps Board" })).toBeVisible();
  await expect(page.getByRole("button", { name: "All projects 9 tasks" })).toBeVisible();

  await page.getByRole("radio", { name: "Backlog" }).click();
  await page.getByPlaceholder(/Search ID/).fill("MGA-002");
  await expect(page.getByText(/^1 of 9 tasks\b/)).toBeVisible();
  await page.getByRole("button", { name: "MGA-002", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: /MGA-002/ });
  await expect(dialog).toBeVisible();
  const status = dialog.getByLabel("Base state");
  const current = await status.inputValue();
  const next = current === "Blocked" ? "Ready" : "Blocked";
  await status.selectOption(next);
  const firstWrite = page.waitForResponse(
    (response) => response.url().endsWith("/api/write") && response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Save status" }).click();
  expect((await firstWrite).status()).toBe(200);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("row").filter({ hasText: "MGA-002" })).toContainText(next);

  const undoWrite = page.waitForResponse(
    (response) => response.url().endsWith("/api/write") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Undo MGA-002" }).first().click();
  expect((await undoWrite).status()).toBe(200);
  await expect(page.getByRole("row").filter({ hasText: "MGA-002" })).toContainText(current);

  await page.getByRole("button", { name: "MGA-002", exact: true }).click();
  await status.selectOption(next);
  const statusWrite = page.waitForResponse(
    (response) => response.url().endsWith("/api/write") && response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Save status" }).click();
  expect((await statusWrite).status()).toBe(200);

  const priority = dialog.getByLabel("Priority");
  const currentPriority = await priority.inputValue();
  const nextPriority = currentPriority === "P2" ? "P1" : "P2";
  await priority.selectOption(nextPriority);
  const priorityWrite = page.waitForResponse(
    (response) => response.url().endsWith("/api/write") && response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Save priority" }).click();
  expect((await priorityWrite).status()).toBe(200);

  const note = "The fictional browser journey recorded this note.";
  await dialog.getByRole("tab", { name: "Evidence", exact: true }).click();
  await dialog.getByPlaceholder("Add a note to the Markdown ledger").fill(note);
  const noteWrite = page.waitForResponse(
    (response) => response.url().endsWith("/api/note") && response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Add note" }).click();
  expect((await noteWrite).status()).toBe(200);
  await expect(dialog.getByText(note)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const commitPanel = page.getByRole("region", { name: "Commit changes" });
  await expect(commitPanel.getByText("1 Markdown path included")).toBeVisible();
  await expect(commitPanel.getByText("1 dirty path excluded")).toBeVisible();
  await commitPanel.getByText("Commit preview", { exact: true }).click();
  await expect(commitPanel.getByText("plans/moon-garden.md", { exact: true })).toBeVisible();
  await expect(commitPanel.getByText("README.md", { exact: true })).toBeVisible();
  await page.getByLabel("New branch").fill("plan/browser-journey");
  await page.getByLabel("Commit message (optional)").fill("Exercise the fictional browser journey");
  const commitRequest = page.waitForResponse(
    (response) => response.url().endsWith("/api/git/commit") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Commit", exact: true }).click();
  expect((await commitRequest).status()).toBe(200);
  await expect(page.getByLabel("New branch")).toBeHidden();

  const gitStatus = await page.request.get("/api/git/status");
  expect(gitStatus.status()).toBe(200);
  expect(await gitStatus.json()).toMatchObject({
    branch: "plan/browser-journey",
    changedPlanningFiles: [],
    otherChangedFiles: ["README.md"],
  });
  await expect(commitPanel.getByText("No configured Markdown changes to commit.")).toBeVisible();
});

for (const viewport of [1440, 1920]) {
  test(`task reader presets keep at least half of a ${viewport}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width: viewport, height: 1000 });
    const mutations: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/") && request.method() !== "GET") mutations.push(request.url());
    });
    await page.route("**/api/board", async (route) => {
      const response = await route.fetch(), board = boardSchema.parse(await response.json());
      await route.fulfill({ response, json: { ...board, tasks: board.tasks.map((task) => task.id === "MGA-002"
        ? { ...task, packetMetadata: { ...task.packetMetadata, workKind: "verification", estimatedChangedLoc: null } } : task) } });
    });
    await page.goto("/#view=backlog");
    const trigger = page.getByRole("button", { name: "MGA-002", exact: true });
    await trigger.click();
    const reader = page.getByRole("dialog");
    const width = reader.getByRole("combobox", { name: "Reader width" });
    await expect(width).toHaveValue("60");
    expect((await reader.boundingBox())?.width).toBeCloseTo(viewport * 0.6, 0);
    for (const percentage of [50, 60, 75, 100]) {
      await width.selectOption(String(percentage));
      const bounds = await reader.boundingBox();
      expect(bounds?.width).toBeCloseTo(viewport * percentage / 100, 0);
      expect(bounds?.width).toBeGreaterThanOrEqual(viewport / 2);
    }
    await width.selectOption("75");
    for (const name of ["Implementation", "Evidence", "Overview", "Dependencies"]) {
      await reader.getByRole("tab", { name, exact: true }).click();
      await expect(reader.getByRole("tabpanel")).toHaveCount(1);
      const summary = reader.getByRole("region", { name: "Derived implementation summary" });
      if (name === "Implementation") {
        await expect(summary.getByText("verification", { exact: true })).toBeVisible();
        await expect(summary.getByText("Not applicable", { exact: true })).toHaveCount(3);
        await expect(reader.getByRole("region", { name: "Recorded fields" })).toBeVisible();
        await expect(summary.getByRole("link")).toHaveCount(0);
        await expect(summary.getByRole("button")).toHaveCount(0);
      } else {
        await expect(summary).toHaveCount(0);
        await expect(reader.getByRole("region", { name: "Recorded fields" })).toHaveCount(0);
      }
    }
    await reader.getByRole("button", { name: "MGA-001", exact: true }).first().click();
    await expect(reader.getByRole("heading", { level: 2 })).toContainText("MGA-001");
    await expect(reader.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    await expect(width).toHaveValue("75");
    expect((await reader.boundingBox())?.width).toBeCloseTo(viewport * 0.75, 0);
    await page.keyboard.press("Escape");
    await expect(reader).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(mutations).toEqual([]);
  });
}

for (const viewport of [320, 390, 800]) {
  test(`task reader fills the ${viewport}px viewport regardless of its desktop preset`, async ({ page }) => {
    await page.setViewportSize({ width: viewport, height: 900 });
    await page.goto("/#task=MGA-002");
    const reader = page.getByRole("dialog");
    await expect(reader).toBeVisible();
    for (const percentage of [50, 60, 75, 100]) {
      await reader.getByRole("combobox", { name: "Reader width" }).selectOption(String(percentage));
      const bounds = await reader.boundingBox();
      expect(bounds?.width).toBeCloseTo(viewport, 0);
      expect(bounds?.x).toBeGreaterThanOrEqual(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport);
    }
  });
}

const visibleScrollbarTest = test.extend({
  launchOptions: {
    ignoreDefaultArgs: ["--hide-scrollbars"],
    args: ["--disable-features=OverlayScrollbar"],
  },
});

test("Roadmap native disclosures preserve keyboard navigation and story links without writes", async ({ page }) => {
  const mutations: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/") && request.method() !== "GET") mutations.push(request.method()); });
  await page.goto("/#view=stories");
  await expect(page.getByRole("radio", { name: "Roadmap", exact: true })).toBeChecked();
  const projects = page.getByRole("group", { name: /^Project / });
  const project = projects.first(), sibling = projects.nth(1);
  const epic = project.getByRole("group", { name: /^Epic / }).first();
  const outcome = epic.getByRole("group", { name: /^(Story|Enabler) / }).first();
  const projectSummary = project.locator(":scope > summary"), epicSummary = epic.locator(":scope > summary");
  const outcomeSummary = outcome.locator(":scope > summary"), action = outcome.getByRole("button", { name: /^Open story / });
  await expect(project).toHaveAttribute("open", ""); await expect(epic).toHaveAttribute("open", "");
  await expect(outcome).not.toHaveAttribute("open");
  const activate = async (disclosure: Locator, key: string, open: boolean) => {
    await disclosure.evaluate((element) => {
      if (!element.hasAttribute("data-observed-toggles")) element.addEventListener("toggle", () => element.setAttribute("data-observed-toggles", String(Number(element.getAttribute("data-observed-toggles")) + 1)));
      element.setAttribute("data-observed-toggles", "0");
    });
    await page.keyboard.press(key);
    if (open) await expect(disclosure).toHaveAttribute("open", ""); else await expect(disclosure).not.toHaveAttribute("open");
    await expect(disclosure).toHaveAttribute("data-observed-toggles", "1");
  };
  await projectSummary.focus(); await page.keyboard.press("Tab"); await expect(epicSummary).toBeFocused();
  await page.keyboard.press("Shift+Tab"); await expect(projectSummary).toBeFocused();
  for (const key of ["Enter", "Space"]) {
    await activate(project, key, false); await expect(sibling).toHaveAttribute("open", "");
    await page.keyboard.press("Tab"); await expect(sibling.locator(":scope > summary")).toBeFocused();
    await page.keyboard.press("Shift+Tab"); await expect(projectSummary).toBeFocused(); await activate(project, key, true);
  }
  await page.keyboard.press("Tab"); await expect(epicSummary).toBeFocused();
  for (const key of ["Enter", "Space"]) {
    await activate(epic, key, false); await expect(project).toHaveAttribute("open", "");
    await page.keyboard.press("Tab"); await expect(sibling.locator(":scope > summary")).toBeFocused();
    await page.keyboard.press("Shift+Tab"); await expect(epicSummary).toBeFocused(); await activate(epic, key, true);
  }
  await page.keyboard.press("Tab"); await expect(outcomeSummary).toBeFocused();
  const focus = await outcomeSummary.evaluate((element) => {
    const style = getComputedStyle(element); return { visible: element.matches(":focus-visible"), shadow: style.boxShadow, outline: style.outlineStyle };
  });
  expect(focus.visible).toBe(true); expect(focus.shadow !== "none" || focus.outline !== "none").toBe(true);
  for (const key of ["Enter", "Space"]) {
    await activate(outcome, key, true); await expect(project).toHaveAttribute("open", ""); await expect(epic).toHaveAttribute("open", "");
    await page.keyboard.press("Tab"); await expect(action).toBeFocused();
    await page.keyboard.press("Shift+Tab"); await expect(outcomeSummary).toBeFocused(); await activate(outcome, key, false);
    await page.keyboard.press("Tab"); await expect(sibling.locator(":scope > summary")).toBeFocused();
    await page.keyboard.press("Shift+Tab"); await expect(outcomeSummary).toBeFocused();
  }
  await activate(outcome, "Enter", true); await page.keyboard.press("Tab"); await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible(); await expect(page).toHaveURL(/#view=stories&story=/);
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toBeHidden();
  await expect(action).toBeFocused(); await expect(page).toHaveURL(/#view=stories$/); await expect(outcome).toHaveAttribute("open", "");
  expect(mutations).toEqual([]);
});

visibleScrollbarTest.describe("task reader with visible scrollbars", () => {
  for (const viewport of [800, 390]) {
    visibleScrollbarTest(`keeps both edges inside the ${viewport}px viewport`, async ({ page }) => {
      await page.setViewportSize({ width: viewport, height: 900 });
      await page.goto("/#view=backlog");
      await page.addStyleTag({ content: "body { min-height: 3000px; }" });
      await page.evaluate(() => { document.body.style.overflow = "auto"; });
      expect(await page.evaluate(() => document.documentElement.clientWidth)).toBeLessThan(viewport);
      await page.getByRole("button", { name: "MGA-002", exact: true }).click();
      const reader = page.getByRole("dialog");
      await expect(reader).toBeVisible();
      for (const percentage of [50, 60, 75, 100]) {
        await reader.getByRole("combobox", { name: "Reader width" }).selectOption(String(percentage));
        const bounds = await reader.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.width).toBeCloseTo(viewport, 0);
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport);
      }
      await page.keyboard.press("Escape");
      await expect(reader).toBeHidden();
      expect(await page.evaluate(() => document.body.style.overflow)).toBe("auto");
      expect(await page.evaluate(() => document.documentElement.clientWidth)).toBeLessThan(viewport);
    });
  }
});
