import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { boardSchema } from "../shared/contracts.ts";

test("main views have no detectable WCAG 2.2 AA violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "PlanOps Board" })).toBeVisible();
  await expect(page.getByRole("button", { name: "All projects 9 tasks" })).toBeVisible();

  for (const view of ["Now", "Roadmap", "Rollup", "Board", "Backlog", "Dependencies"]) {
    await page.getByRole("radio", { name: view, exact: true }).click();
    if (view === "Dependencies") {
      await expect(page.getByRole("group", { name: "Task dependency graph", exact: true })).toBeVisible();
    }
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
    if (name === "Evidence") await expect(dialog.getByRole("region", { name: "Readiness states" })
      .getByText("Dispatch audit: unavailable - readiness manifest missing", { exact: true })).toBeVisible();
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

const wcagTags = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];

test("reader tabs announce selection separately from focus and expose packet diagnostics", async ({ page }) => {
  await page.goto("/#view=backlog");
  await page.getByRole("button", { name: "MGA-002", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /MGA-002/ });
  const tabs = dialog.getByRole("tablist", { name: "Task content" });
  const tab = (name: string) => dialog.getByRole("tab", { name, exact: true });
  await tab("Overview").focus();
  await page.keyboard.press("ArrowRight");
  await expect(tab("Implementation")).toBeFocused();
  await expect(tab("Overview")).toHaveAttribute("aria-selected", "true");
  await expect(tab("Implementation")).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("Enter");
  expect(await tabs.ariaSnapshot()).toContain('tab "Implementation" [selected]');
  await expect(dialog.getByRole("tabpanel", { name: "Implementation", exact: true })).toBeVisible();
  const summary = dialog.getByRole("region", { name: "Derived implementation summary" });
  await expect(summary.getByRole("heading", { level: 4, name: "Packet diagnostics", exact: true })).toBeVisible();
  const diagnostics = summary.getByRole("list", { name: "Packet diagnostics", exact: true });
  await expect(diagnostics.getByRole("listitem").filter({ hasText: "the ordered 15-field packet is incomplete" })).toBeVisible();
  for (const [key, name] of [["End", "Evidence"], ["ArrowRight", "Overview"], ["ArrowLeft", "Evidence"], ["Home", "Overview"], ["ArrowLeft", "Evidence"]] as const) {
    await page.keyboard.press(key);
    await expect(tab(name)).toBeFocused();
    await expect(dialog.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
    await expect(tab(name)).toHaveAttribute("tabindex", "0");
    await expect(tab("Implementation")).toHaveAttribute("aria-selected", "true");
  }
  const results = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
  expect(results.violations).toEqual([]);
});

test("changing task inside the reader moves focus into the new task and resets to Overview", async ({ page }) => {
  await page.goto("/#view=backlog");
  await page.getByRole("button", { name: "MGA-002", exact: true }).click();
  const second = page.getByRole("dialog", { name: /MGA-002/ });
  await expect(second).toBeVisible();
  await second.getByRole("tab", { name: "Dependencies", exact: true }).click();
  await second.getByRole("button", { name: "MGA-001", exact: true }).focus();
  await page.keyboard.press("Enter");
  const first = page.getByRole("dialog", { name: /MGA-001/ });
  await expect(first).toBeVisible();
  await expect(first.getByTestId("task-drawer-focus")).toBeFocused();
  await expect(first.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
  expect(page.url()).toContain("task=MGA-001");
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  await first.getByRole("tab", { name: "Implementation", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(first.getByRole("tab", { name: "Implementation", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(first.getByRole("tab", { name: "Implementation", exact: true })).toBeFocused();
  await page.goBack();
  const back = page.getByRole("dialog", { name: /MGA-002/ });
  await expect(back).toBeVisible();
  await expect(back.getByTestId("task-drawer-focus")).toBeFocused();
  await expect(back.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
  const results = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
  expect(results.violations).toEqual([]);
});

test("empty packet diagnostics leave no stale diagnostics and hostile labels stay inert", async ({ page }) => {
  const hostile = "<img src=x onerror=alert(1)> <a href=#x>link</a> <button>b</button>";
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.route("**/api/board", async (route) => {
    const response = await route.fetch(), board = boardSchema.parse(await response.json());
    const json = boardSchema.parse({ ...board, tasks: board.tasks.map((task) => task.id === "MGA-002" ? { ...task, packetMetadata: {
      ...task.packetMetadata, issues: [hostile, "Second fictional diagnostic"], files: [{ repository: "moon-garden-ui", path: "src/filters.ts",
        state: "existing", symbols: [hostile], behavior: hostile, writeBoundary: "Filters only", proof: hostile }],
    } } : task.id === "MGA-001" ? { ...task, packetMetadata: { ...task.packetMetadata, issues: [], sizeException: null } } : task) });
    await route.fulfill({ response, json });
  });
  await page.goto("/#task=MGA-002");
  const first = page.getByRole("dialog", { name: /MGA-002/ });
  await first.getByRole("tab", { name: "Implementation", exact: true }).click();
  const firstSummary = first.getByRole("region", { name: "Derived implementation summary" });
  const firstList = firstSummary.getByRole("list", { name: "Packet diagnostics", exact: true });
  await expect(firstList.getByRole("listitem")).toHaveCount(2);
  await expect(firstList.getByRole("listitem").first()).toHaveText(hostile, { useInnerText: true });
  await expect(firstSummary.getByText(hostile, { exact: true })).toHaveCount(4);
  await expect(firstSummary.locator("a, button, img, script, input, select, textarea, [tabindex]")).toHaveCount(0);
  await first.getByRole("tab", { name: "Dependencies", exact: true }).click();
  await first.getByRole("button", { name: "MGA-001", exact: true }).focus();
  await page.keyboard.press("Enter");
  const second = page.getByRole("dialog", { name: /MGA-001/ });
  await expect(second.getByTestId("task-drawer-focus")).toBeFocused();
  await second.getByRole("tab", { name: "Overview", exact: true }).focus();
  await page.keyboard.press("ArrowRight"); await page.keyboard.press("Enter");
  await expect(second.getByRole("tab", { name: "Implementation", exact: true })).toHaveAttribute("aria-selected", "true");
  const secondSummary = second.getByRole("region", { name: "Derived implementation summary" });
  await expect(secondSummary).toBeVisible();
  await expect(second.getByRole("heading", { name: "Packet diagnostics" })).toHaveCount(0);
  await expect(second.getByRole("list", { name: "Packet diagnostics" })).toHaveCount(0);
  await expect(page.getByText("Second fictional diagnostic")).toHaveCount(0);
  await expect(page.getByText(hostile, { exact: true })).toHaveCount(0);
  const results = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
  expect(results.violations).toEqual([]);
  expect(dialogs).toEqual([]);
});

for (const width of [1280, 320]) {
  test(`open task menus in Now, Board and Backlog have no WCAG 2.2 AA violations at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    for (const [view, radio] of [["now", "Now"], ["kanban", "Board"], ["backlog", "Backlog"]]) {
      await page.goto(`/#view=${view}&project=moon-garden`);
      await expect(page.getByRole("radio", { name: radio, exact: true })).toBeChecked();
      const trigger = page.getByRole("button", { name: "Actions for MGA-002", exact: true });
      await trigger.click();
      const menu = page.getByRole("menu", { name: "Actions for MGA-002" });
      await expect(menu.getByRole("menuitem").first()).toBeFocused();
      const results = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
      expect(results.violations, `${view}: ${JSON.stringify(results.violations, null, 2)}`).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
  });
}

test("the rail project menu at 320px has no WCAG 2.2 AA violations", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Open Signal Harbor in a view", exact: true });
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Open Signal Harbor in a view" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Open roadmap", "Open board", "Open dependencies"]);
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  const results = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("the desktop rail project menu opens over the next row and its own targets meet WCAG 2.2 AA", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Open Moon Garden in a view", exact: true });
  const nextTrigger = page.getByRole("button", { name: "Open Signal Harbor in a view", exact: true });
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Open Moon Garden in a view" });
  const items = menu.getByRole("menuitem");
  await expect(items).toHaveText(["Open roadmap", "Open board", "Open dependencies"]);
  await expect(items.first()).toBeFocused();
  const [triggerBox, nextBox, menuBox] = await Promise.all([trigger.boundingBox(), nextTrigger.boundingBox(), menu.boundingBox()]);
  expect(menuBox!.y).toBeGreaterThan(triggerBox!.y + triggerBox!.height);
  expect(menuBox!.y).toBeLessThan(nextBox!.y);
  expect(menuBox!.y + menuBox!.height).toBeGreaterThan(nextBox!.y + nextBox!.height);
  const centreHit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[role="menu"]')?.getAttribute("role") ?? null,
    { x: nextBox!.x + nextBox!.width / 2, y: nextBox!.y + nextBox!.height / 2 });
  expect(centreHit).toBe("menu");
  for (let index = 0; index < 3; index += 1) {
    const box = await items.nth(index).boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(24);
    expect(box?.height).toBeGreaterThanOrEqual(24);
  }
  const results = await new AxeBuilder({ page }).include('[role="menu"]').withTags(wcagTags).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  expect(results.passes.find((pass) => pass.id === "target-size")?.nodes.length).toBe(3);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("held readiness chips and paused Roadmap filters have no WCAG 2.2 AA violations", async ({ page }) => {
  for (const [view, radio] of [["kanban", "Board"], ["backlog", "Backlog"]]) {
    await page.goto(`/#view=${view}&project=signal-harbor&readiness=waiting`);
    await expect(page.getByRole("radio", { name: radio, exact: true })).toBeChecked();
    await expect(page.getByRole("button", { name: "Remove readiness filter: waiting", exact: true })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
    expect(results.violations, `${view}: ${JSON.stringify(results.violations, null, 2)}`).toEqual([]);
  }
  await page.goto("/#view=stories&project=moon-garden&q=MGA-002&status=Ready");
  await expect(page.getByRole("radio", { name: "Roadmap", exact: true })).toBeChecked();
  await expect(page.getByRole("region", { name: "Paused task filters" })).toContainText("MGA-002");
  const results = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});
