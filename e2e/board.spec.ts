import { expect, test, type Locator } from "@playwright/test";
import { boardSchema } from "../shared/contracts.ts";

import { resetBrowserRepository } from "./fixture.ts";

test.setTimeout(60_000);

test.beforeEach(async () => {
  await resetBrowserRepository();
});

test("authors a story, linked task, two subtasks and one toggle through guarded Roadmap writes", async ({ page }) => {
  const mutations: string[] = [];
  const requests: string[] = [];
  page.on("request", (request) => {
    requests.push(request.url());
    if (request.method() !== "GET") mutations.push(request.url());
  });
  const readBoard = async () => {
    const response = await page.request.get("/api/board");
    expect(response.status()).toBe(200);
    return boardSchema.parse(await response.json());
  };
  const save = async (form: Locator, expected: Record<string, unknown>) => {
    const before = await readBoard();
    const baseSha256 = before.documents.find((document) => document.path === "plans/moon-garden.md")!.sha256;
    const responsePromise = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/write" && response.request().method() === "POST");
    await form.getByRole("button", { name: "Save" }).click();
    const response = await responsePromise;
    expect(response.status(), await response.text()).toBe(200);
    expect(response.request().postDataJSON()).toMatchObject({ file: "plans/moon-garden.md", baseSha256, ...expected });
    return response;
  };

  await page.goto("/#view=stories&project=moon-garden");
  await expect(page.getByRole("radio", { name: "Roadmap", exact: true })).toBeChecked();
  const epic = page.getByRole("group", { name: "Epic plans/moon-garden.md in moon-garden" });
  await epic.getByRole("button", { name: "Add story in plans/moon-garden.md" }).click();
  const storyForm = page.getByRole("form", { name: "Create story in plans/moon-garden.md" });
  await storyForm.getByLabel("Story ID").fill("MGA-S02");
  await storyForm.getByLabel("Title").fill("Visitors compare habitats");
  await storyForm.getByLabel("Outcome").fill("I can compare habitats");
  await storyForm.getByLabel("So that").fill("I choose a suitable garden");
  await save(storyForm, { operation: "create.story", id: "MGA-S02", title: "Visitors compare habitats",
    outcome: "I can compare habitats", soThat: "I choose a suitable garden" });
  let outcome = page.getByRole("group", { name: /^Story MGA-S02 from plans\/moon-garden\.md line / });
  await expect(outcome).toBeVisible();
  await outcome.locator(":scope > summary").click();
  await outcome.getByRole("button", { name: "Add task to MGA-S02" }).click();
  const taskForm = page.getByRole("form", { name: "Create task for MGA-S02" });
  await taskForm.getByLabel("Task ID").fill("MGA-004");
  await taskForm.getByLabel("Title").fill("Compare habitat requirements");
  await taskForm.getByLabel("Priority").selectOption("P1");
  await taskForm.getByLabel("Status").selectOption("Ready");
  await taskForm.getByLabel("Dependencies").fill("None");
  await taskForm.getByLabel("Repository / owner").fill("moon-garden-ui");
  await taskForm.getByLabel("Required outcome").fill("Visitors compare habitats.");
  const table = (await readBoard()).taskTables.find((candidate) => candidate.file === "plans/moon-garden.md")!;
  await save(taskForm, { operation: "create.task", id: "MGA-004", storyId: "MGA-S02",
    title: "Compare habitat requirements", tableHeaderLine: table.headerLine,
    cells: { Priority: "P1", Status: "Ready", Dependencies: "None", "Repository / owner": "moon-garden-ui",
      "Required outcome": "Visitors compare habitats." } });
  outcome = page.getByRole("group", { name: "Project Moon Garden" })
    .getByRole("group", { name: /^Story MGA-S02 from plans\/moon-garden\.md line / });
  await expect(outcome).toBeAttached();
  if (!(await outcome.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await outcome.locator(":scope > summary").click();
  }
  await expect(outcome.getByText("Compare habitat requirements")).toBeVisible();

  for (const [id, title] of [["MGA-004.1", "Inspect habitat light"], ["MGA-004.2", "Check garden temperature"]] as const) {
    await outcome.getByRole("button", { name: "Add subtask to MGA-004" }).click();
    const form = page.getByRole("form", { name: "Create subtask for MGA-004" });
    await form.getByLabel("Subtask ID").fill(id);
    await form.getByLabel("Title").fill(title);
    await save(form, { operation: "create.subtask", taskId: "MGA-004", id, title });
    await expect(outcome.getByRole("checkbox", { name: `${id} ${title}` })).not.toBeChecked();
  }
  const first = outcome.getByRole("checkbox", { name: "MGA-004.1 Inspect habitat light" });
  const second = outcome.getByRole("checkbox", { name: "MGA-004.2 Check garden temperature" });
  const beforeToggle = await readBoard();
  const baseSha256 = beforeToggle.documents.find((document) => document.path === "plans/moon-garden.md")!.sha256;
  const toggleResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/write" && response.request().method() === "POST");
  await first.click();
  const toggled = await toggleResponse;
  expect(toggled.status(), await toggled.text()).toBe(200);
  expect(toggled.request().postDataJSON()).toMatchObject({ operation: "toggle.subtask", file: "plans/moon-garden.md",
    baseSha256, taskId: "MGA-004", id: "MGA-004.1" });
  await expect(first).toBeChecked();
  await expect(second).not.toBeChecked();
  const final = await readBoard();
  expect(final.stories.find((entry) => entry.id === "MGA-S02")?.taskIds).toEqual(["MGA-004"]);
  expect(final.tasks.find((entry) => entry.id === "MGA-004")?.storyId).toBe("MGA-S02");
  expect(final.tasks.find((entry) => entry.id === "MGA-004")?.subtasks).toMatchObject([
    { id: "MGA-004.1", done: true }, { id: "MGA-004.2", done: false },
  ]);
  expect(mutations).toEqual(Array(5).fill(new URL("/api/write", page.url()).href));
  expect(requests.filter((url) => /\/(?:api\/git\/commit|api\/(?:agent|model)|v1\/(?:chat\/completions|responses)|models)(?:\/|$)/i
    .test(new URL(url).pathname))).toEqual([]);
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

test("collapses the project explorer while keeping project navigation available", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  const rail = page.getByRole("complementary", { name: "Project explorer" });
  await expect(page.getByRole("button", { name: "Collapse project explorer" })).toBeVisible();
  await expect(page.getByTestId("source-revision-status")).toHaveText("Snapshot current at local source");
  const expandedWidth = (await rail.boundingBox())?.width;
  await page.getByRole("button", { name: "Collapse project explorer" }).click();
  await expect(page.getByRole("button", { name: "Expand project explorer" })).toHaveAttribute("aria-expanded", "false");
  const moonGarden = page.getByRole("button", { name: /^Moon Garden .* tasks/ });
  await expect(moonGarden).toBeVisible();
  const collapsedWidth = (await rail.boundingBox())?.width;
  expect(expandedWidth).toBeGreaterThan(200);
  expect(collapsedWidth).toBeCloseTo(64, 0);
  await moonGarden.click();
  await expect(moonGarden).toHaveAttribute("aria-current", "true");
  await page.getByRole("button", { name: "Expand project explorer" }).click();
  await expect(page.getByRole("button", { name: "Collapse project explorer" })).toHaveAttribute("aria-expanded", "true");
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
  const addStory = epic.getByRole("button", { name: /^Add story in / });
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
    await page.keyboard.press("Tab"); await expect(addStory).toBeFocused();
    await page.keyboard.press("Tab"); await expect(sibling.locator(":scope > summary")).toBeFocused();
    await page.keyboard.press("Shift+Tab"); await expect(addStory).toBeFocused();
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
