import { expect, test } from "@playwright/test";
import { resetBrowserRepository } from "./fixture.ts";

test.beforeEach(async () => {
  await resetBrowserRepository();
});

test("task actions open a visible graph and retain its focus through the reader and browser history", async ({ page }) => {
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/") && request.method() !== "GET") mutations.push(request.url());
  });
  await page.goto("/#view=kanban&project=moon-garden");
  await page.getByRole("button", { name: "Actions for MGA-002", exact: true }).click();
  await page.getByRole("menuitem", { name: "Show dependencies" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/#view=graph&focus=MGA-002$/);
  await expect(page.getByRole("group", { name: "Task dependency graph", exact: true })).toBeVisible();
  const selection = page.getByRole("region", { name: "Selected dependency task" });
  await expect(selection).toContainText("MGA-002");
  await page.reload();
  await expect(selection).toContainText("MGA-002");
  await page.getByRole("button", { name: /^Select MGA-001:/ }).click();
  await expect(selection).toContainText("MGA-001");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goBack();
  await expect(selection).toContainText("MGA-002");
  const details = selection.getByRole("button", { name: "Open task details" });
  await details.click();
  await expect(page.getByRole("dialog", { name: /MGA-002/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(details).toBeFocused();
  await expect(selection).toContainText("MGA-002");
  await selection.getByRole("button", { name: "Actions for MGA-002", exact: true }).click();
  await page.getByRole("menuitem", { name: "Find in backlog" }).click();
  await expect(page.getByRole("button", { name: "MGA-002", exact: true })).toBeVisible();
  await expect(page.getByPlaceholder(/Search ID/)).toHaveValue("MGA-002");
  await page.goBack();
  await expect(selection).toContainText("MGA-002");
  await page.goto("/#view=graph&project=moon-garden&focus=SHB-002");
  await selection.getByRole("button", { name: "Actions for SHB-002", exact: true }).click();
  await page.getByRole("menuitem", { name: "Find in backlog" }).click();
  await expect(page.getByRole("button", { name: "SHB-002", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#view=backlog&q=SHB-002$/);
  expect(mutations).toEqual([]);
});

test("paused filters resume across views and a new project starts with its full scope", async ({ page }) => {
  await page.goto("/#view=backlog&project=moon-garden&q=MGA-002&status=Ready");
  await page.getByRole("radio", { name: "Roadmap", exact: true }).click();
  const paused = page.getByRole("region", { name: "Paused task filters" });
  await expect(paused).toContainText("MGA-002");
  await paused.getByRole("button", { name: "View filtered tasks" }).click();
  await expect(page.getByPlaceholder(/Search ID/)).toHaveValue("MGA-002");
  await expect(page.getByRole("combobox", { name: "Status" })).toHaveValue("Ready");
  await page.getByRole("button", { name: /^Signal Harbor \d+ tasks/ }).click();
  await expect(page.getByPlaceholder(/Search ID/)).toHaveValue("");
  await expect(page.getByRole("button", { name: "SHB-002", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByPlaceholder(/Search ID/)).toHaveValue("MGA-002");
  await expect(page.getByRole("button", { name: /^Moon Garden \d+ tasks/ })).toHaveAttribute("aria-current", "true");
});

test("mobile task menus stay in the viewport and return keyboard focus", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/#view=kanban");
  const trigger = page.getByRole("button", { name: "Actions for MGA-002", exact: true });
  await trigger.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const bounds = await menu.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(8);
  expect(bounds!.y).toBeGreaterThanOrEqual(8);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(312);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(712);
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem").last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test("project search opens a scoped view and recovers from an empty result on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/");
  const search = page.getByRole("searchbox", { name: "Find project" });
  await search.fill("signal");
  await expect(page.getByRole("status")).toContainText("1 of 4 projects");
  await page.getByRole("button", { name: "Open Signal Harbor in a view" }).click();
  await page.getByRole("menuitem", { name: "Open board" }).click();
  await expect(page).toHaveURL(/#view=kanban&project=signal-harbor$/);
  await expect(page.getByRole("radio", { name: "Board", exact: true })).toBeChecked();
  await expect(search).toHaveValue("signal");
  await search.fill("nothing-matches");
  await expect(page.getByText("No projects match “nothing-matches”.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Signal Harbor" })).toBeVisible();
  await page.getByRole("button", { name: "Clear project search" }).click();
  await expect(search).toBeFocused();
  await expect(page.getByRole("button", { name: /^Signal Harbor \d+ tasks/ })).toHaveAttribute("aria-current", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});
