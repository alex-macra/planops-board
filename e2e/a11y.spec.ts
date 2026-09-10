import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { boardSchema } from "../shared/contracts.ts";

test("main views have no detectable WCAG 2.2 AA violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "PlanOps Board" })).toBeVisible();

  for (const view of ["Now", "Roadmap", "Rollup", "Board", "Backlog", "Dependencies"]) {
    await page.getByRole("radio", { name: view, exact: true }).click();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations, `${view}: ${JSON.stringify(results.violations, null, 2)}`).toEqual([]);
  }
});

test("Roadmap long fictional hierarchy reflows at 320px with independent outcomes and clear markers", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const mutations: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/") && request.method() !== "GET") mutations.push(request.method()); });
  const label = "Observatory".repeat(30), title = "LunarHabitat".repeat(30), outcomeText = "ObserveTheLunarSky".repeat(30);
  const path = `plans/${"observatory/".repeat(30)}sky.md`;
  await page.route("**/api/board", async (route) => {
    const response = await route.fetch(), board = boardSchema.parse(await response.json());
    const source = board.stories.find((story) => story.id === "MGA-S01")!;
    const json = boardSchema.parse({ ...board,
      projects: board.projects.map((project) => project.id === "moon-garden" ? { ...project, label } : project),
      documents: board.documents.map((document) => document.path === source.file ? { ...document, path, title } : document),
      tasks: board.tasks.map((task) => task.file === source.file ? { ...task, file: path, epic: title } : task),
      stories: [...board.stories.filter((story) => story.id !== source.id),
        { ...source, file: path, outcome: outcomeText, taskIds: ["MGA-001", "MGA-002"] },
        { ...source, id: "MGA-S02", file: path, headingLine: 99, kind: "enabler", role: null, outcome: "Calibrate the fictional habitat", taskIds: ["MGA-003"] }],
    });
    await route.fulfill({ response, json });
  });
  await page.goto("/#view=stories&project=moon-garden");
  const project = page.getByRole("group", { name: `Project ${label}` });
  const epic = project.getByRole("group", { name: `Epic ${path} in moon-garden` });
  const first = epic.getByRole("group", { name: /^Story MGA-S01 / }), second = epic.getByRole("group", { name: /^Enabler MGA-S02 / });
  await expect(project.locator(":scope > summary")).toContainText("1 epic"); await expect(project.locator(":scope > summary")).toContainText("2 outcomes");
  await expect(epic.locator(":scope > summary")).toContainText(title); await expect(epic.getByText(path, { exact: true })).toBeVisible();
  await expect(first.locator(":scope > summary")).toContainText(outcomeText); await expect(first.locator(":scope > summary")).toContainText("Full group: 1 of 2 complete");
  await expect(first.locator(":scope > summary")).toContainText("in flight");
  expect(await project.locator(":scope > summary").evaluate((element) => getComputedStyle(element, "::before").content)).toBe('"-"');
  for (const disclosure of [first, second]) {
    expect(await disclosure.locator(":scope > summary").evaluate((element) => getComputedStyle(element, "::before").content)).toBe('"+"');
    await disclosure.locator(":scope > summary").focus(); await page.keyboard.press("Enter"); await expect(disclosure).toHaveAttribute("open", "");
  }
  await first.locator(":scope > summary").focus(); await page.keyboard.press("Space");
  await expect(first).not.toHaveAttribute("open"); await expect(second).toHaveAttribute("open", "");
  expect(await first.locator(":scope > summary").evaluate((element) => getComputedStyle(element, "::before").content)).toBe('"+"');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations).toEqual([]); expect(mutations).toEqual([]);
});

test("the task drawer traps focus, closes with Escape, and returns focus", async ({ page }) => {
  await page.goto("/#view=backlog");
  const trigger = page.getByRole("button", { name: "MGA-002", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: /MGA-002/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(":focus")).toBeVisible();
  await dialog.getByRole("combobox", { name: "Reader width" }).selectOption("50");
  await dialog.getByRole("tab", { name: "Overview" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByRole("tab", { name: "Implementation" })).toBeFocused();
  await expect(dialog.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("tab", { name: "Implementation" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End"); await page.keyboard.press("Space");
  await expect(dialog.getByRole("tab", { name: "Evidence" })).toHaveAttribute("aria-selected", "true");
  for (const name of ["Overview", "Implementation", "Dependencies", "Evidence"]) {
    await dialog.getByRole("tab", { name, exact: true }).click();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations, name).toEqual([]);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("the narrow reader contains long titles, paths and code without losing controls", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const mutations: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/") && request.method() !== "GET") mutations.push(request.url()); });
  const hostile = "<img src=x onerror=alert(1)> `MGA-001`";
  const excerpt = `\`\`\`text\n${"calibration ".repeat(120)}\n\`\`\``;
  await page.route("**/api/board", async (route) => {
    const response = await route.fetch();
    const board = boardSchema.parse(await response.json());
    const title = "Observation".repeat(70);
    await route.fulfill({
      response,
      json: {
        ...board,
        tasks: board.tasks.map((task) => task.id === "MGA-002" ? { ...task, title, packetMetadata: {
          ...task.packetMetadata, workKind: "implementation", files: [{ repository: "orbit", path: `src/${"observations/".repeat(80)}index.ts`,
            state: "existing", symbols: ["observe".repeat(80)], behavior: "Record an observation", writeBoundary: "Observation only", proof: hostile }],
        } } : task),
        details: board.details.map((detail) => detail.id === "MGA-002" ? {
          ...detail,
          title,
          prose: [...detail.prose, `src/${"observations/".repeat(80)}index.ts`, excerpt],
        } : detail),
      },
    });
  });
  await page.goto("/#task=MGA-002");
  const reader = page.getByRole("dialog");
  await expect(reader.getByRole("combobox", { name: "Reader width" })).toBeVisible();
  await expect(reader.getByRole("button", { name: "Close", exact: true })).toBeVisible();
  await reader.getByRole("tab", { name: "Implementation", exact: true }).click();
  await page.keyboard.press("Tab");
  await expect(reader.getByRole("region", { name: "Code excerpt" })).toBeFocused();
  expect(await reader.getByRole("region", { name: "Code excerpt" }).textContent()).toBe(excerpt);
  const summary = reader.getByRole("region", { name: "Derived implementation summary" });
  await expect(summary.getByText(hostile, { exact: true })).toBeVisible();
  await expect(summary.getByRole("article")).toHaveCount(1);
  await expect(summary.locator("a, button, img, script")).toHaveCount(0);
  await expect(reader.getByRole("region", { name: "Recorded fields" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  expect(await reader.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations).toEqual([]);
  expect(mutations).toEqual([]);
});

test("the primary view reflows at 320 CSS pixels", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "PlanOps Board" })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});

test("Rollup stale-task controls meet the WCAG 2.2 target minimum", async ({ page }) => {
  await page.goto("/#view=rollup");
  const region = page.getByRole("region", { name: "Stale work" });
  await expect(region).toBeVisible();
  const targets = region
    .getByRole("button", { name: /^[A-Z]{3}-\d{3}$/ });
  await expect(targets.first()).toBeVisible();
  const count = await targets.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const box = await targets.nth(index).boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(24);
    expect(box?.height).toBeGreaterThanOrEqual(24);
  }
});
