import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { boardSchema } from "../shared/contracts.ts";
import { resetBrowserRepository } from "./fixture.ts";

test.setTimeout(90_000);

test.beforeEach(async () => {
  await resetBrowserRepository();
});

const wcagTags = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];

const VIEWS = [
  { radio: "Now", id: "now" },
  { radio: "Roadmap", id: "stories" },
  { radio: "Rollup", id: "rollup" },
  { radio: "Board", id: "kanban" },
  { radio: "Backlog", id: "backlog" },
  { radio: "Dependencies", id: "graph" },
] as const;

type View = (typeof VIEWS)[number];

function recordMutations(page: Page): string[] {
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/") && request.method() !== "GET") mutations.push(`${request.method()} ${request.url()}`);
  });
  return mutations;
}

function scopedUrl(view: View, project: string): RegExp {
  return view.id === "now" ? new RegExp(`#project=${project}$`) : new RegExp(`#view=${view.id}&project=${project}$`);
}

async function expectSignalHarborScope(page: Page, view: View): Promise<void> {
  await expect(page).toHaveURL(scopedUrl(view, "signal-harbor"));
  await expect(page.getByRole("radio", { name: view.radio, exact: true })).toBeChecked();
  await expect(page.getByRole("heading", { level: 2, name: "Signal Harbor", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Signal Harbor \d+ tasks/ })).toHaveAttribute("aria-current", "true");
  if (view.id === "graph") {
    await expect(page.getByRole("group", { name: "Task dependency graph", exact: true })).toBeVisible();
  }
}

async function sixViewJourney(page: Page, eachView: (view: View) => Promise<void>): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "PlanOps Board" })).toBeVisible();
  await page.getByRole("button", { name: /^Signal Harbor \d+ tasks/ }).click();
  await expectSignalHarborScope(page, VIEWS[0]);
  await eachView(VIEWS[0]);

  for (const view of VIEWS.slice(1)) {
    await page.getByRole("radio", { name: view.radio, exact: true }).click();
    await expectSignalHarborScope(page, view);
    await eachView(view);
  }

  await page.reload();
  await expectSignalHarborScope(page, VIEWS[5]);

  for (const view of [...VIEWS.slice(0, 5)].reverse()) {
    await page.goBack();
    await expectSignalHarborScope(page, view);
  }
  for (const view of VIEWS.slice(1)) {
    await page.goForward();
    await expectSignalHarborScope(page, view);
  }
}

test("desktop project scope follows all six views through reload and browser history", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const mutations = recordMutations(page);
  await sixViewJourney(page, async () => undefined);
  expect(mutations).toEqual([]);
});

test("mobile project scope reflows and stays accessible in all six views", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  const mutations = recordMutations(page);
  await sixViewJourney(page, async (view) => {
    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth, view.radio).toBeLessThanOrEqual(dimensions.clientWidth);
    const results = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
    expect(results.violations, `${view.radio}: ${JSON.stringify(results.violations, null, 2)}`).toEqual([]);
  });
  expect(mutations).toEqual([]);
});

for (const view of ["now", "backlog", "kanban"] as const) {
  test(`task actions in ${view} route to the reader and backlog and return focus`, async ({ page }) => {
    const mutations = recordMutations(page);
    const start = `/#view=${view}&project=moon-garden`;
    await page.goto(start);
    const trigger = page.getByRole("button", { name: "Actions for MGA-002", exact: true });
    const menu = page.getByRole("menu", { name: "Actions for MGA-002" });
    const taskItems = menu.getByRole("group", { name: "MGA-002", exact: true }).getByRole("menuitem");

    await trigger.click();
    await expect(taskItems).toHaveText(["Open task details", "Show dependencies", "Find in backlog"]);
    await expect(taskItems.first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "Show dependencies" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();

    if (view === "now") {
      await trigger.click();
      await menu.getByRole("menuitem", { name: "Find in backlog" }).click();
      await expect(page).toHaveURL(/#view=backlog&q=MGA-002&project=moon-garden$/);
      await expect(page.getByRole("radio", { name: "Backlog", exact: true })).toBeChecked();
      await expect(page.getByRole("button", { name: "MGA-002", exact: true })).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(/#view=now&project=moon-garden$/);
      await expect(page.getByRole("radio", { name: "Now", exact: true })).toBeChecked();
    }

    const reader = page.getByRole("dialog", { name: /MGA-002/ });
    await trigger.click();
    await menu.getByRole("menuitem", { name: "Open task details" }).click();
    await expect(reader).toBeVisible();
    await expect(page).toHaveURL(/task=MGA-002/);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(taskItems.first()).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(reader).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page).toHaveURL(/project=moon-garden$/);

    if (view === "backlog") {
      await page.getByRole("button", { name: "Actions for MGA-003", exact: true }).click();
      await page.getByRole("menuitem", { name: "Show dependencies" }).click();
      await expect(page).toHaveURL(/#view=graph&focus=MGA-003$/);
      await expect(page.getByRole("region", { name: "Selected dependency task" })).toContainText("MGA-003");
    }
    expect(mutations).toEqual([]);
  });
}

test("Roadmap stories hand over to the task reader and Rollup cards open a scoped board", async ({ page }) => {
  const mutations = recordMutations(page);
  await page.goto("/#view=stories&project=moon-garden");
  const story = page.getByRole("group", { name: /^Story MGA-S01 / });
  await story.locator(":scope > summary").click();
  await expect(story).toHaveAttribute("open", "");
  await story.getByRole("button", { name: /^Open story MGA-S01 / }).click();
  await expect(page).toHaveURL(/story=MGA-S01/);
  const storyDialog = page.getByRole("dialog", { name: /MGA-S01/ });
  await expect(storyDialog).toBeVisible();
  await storyDialog.getByRole("button", { name: /^MGA-001 .+/ }).click();
  await expect(page).toHaveURL(/task=MGA-001/);
  await expect(page).not.toHaveURL(/story=/);
  await expect(page.getByRole("dialog", { name: /MGA-001/ })).toBeVisible();

  await page.goto("/#view=rollup");
  await page.getByRole("main").getByRole("button", { name: "Moon Garden", exact: true }).click();
  await expect(page).toHaveURL(/#view=kanban&project=moon-garden$/);
  await expect(page.getByRole("radio", { name: "Board", exact: true })).toBeChecked();
  await expect(page.getByRole("heading", { level: 2, name: "Moon Garden", exact: true })).toBeVisible();
  expect(mutations).toEqual([]);
});

test("a held readiness filter stays visible in every row view and can be removed", async ({ page }) => {
  const mutations = recordMutations(page);
  await page.goto("/#view=kanban&project=signal-harbor&readiness=waiting");
  const chip = page.getByRole("button", { name: "Remove readiness filter: waiting", exact: true });
  await expect(chip).toBeVisible();
  for (const radio of ["Backlog", "Dependencies"]) {
    await page.getByRole("radio", { name: radio, exact: true }).click();
    await expect(page).toHaveURL(/readiness=waiting/);
    await expect(chip).toBeVisible();
  }
  await chip.click();
  await expect(page).not.toHaveURL(/readiness=/);
  await expect(page).toHaveURL(/#view=graph&project=signal-harbor$/);
  await expect(chip).toHaveCount(0);
  expect(mutations).toEqual([]);
});

test("stale task and filter links explain themselves and recover", async ({ page }) => {
  const mutations = recordMutations(page);
  await page.goto("/#task=NOPE-404");
  await expect(page.getByText("This task link needs attention", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.goto("/#view=kanban&project=gone-project");
  await expect(page.getByText("This link filters on something that no longer exists", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear it", exact: true }).click();
  await expect(page).toHaveURL(/#view=kanban$/);
  await expect(page.getByText("This link filters on something that no longer exists", { exact: true })).toHaveCount(0);
  expect(mutations).toEqual([]);
});

test("a status save against a ledger changed elsewhere is refused until the board reloads", async ({ page }) => {
  await page.route("**/api/events", (route) => route.abort());
  await page.goto("/#view=backlog&task=MGA-002");
  const dialog = page.getByRole("dialog", { name: /MGA-002/ });
  await expect(dialog).toBeVisible();

  const boardResponse = await page.request.get("/api/board");
  expect(boardResponse.status()).toBe(200);
  const board = boardSchema.parse(await boardResponse.json());
  const document = board.documents.find((candidate) => candidate.path === "plans/moon-garden.md");
  expect(document).toBeDefined();
  const concurrent = await page.request.post("/api/note", {
    data: {
      file: "plans/moon-garden.md",
      taskId: "MGA-003",
      baseSha256: document!.sha256,
      text: "A second fictional session recorded this note.",
    },
  });
  expect(concurrent.status()).toBe(200);

  const status = dialog.getByLabel("Base state");
  const current = await status.inputValue();
  const next = current === "Blocked" ? "Ready" : "Blocked";
  await status.selectOption(next);
  const refused = page.waitForResponse(
    (response) => response.url().endsWith("/api/write") && response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Save status" }).click();
  const refusal = await refused;
  expect(refusal.status()).toBe(409);
  expect(await refusal.json()).toMatchObject({ kind: "conflict" });
  await expect(dialog.getByText(
    "plans/moon-garden.md changed on disk since it was loaded; reload the board before editing",
    { exact: true },
  )).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const reloaded = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/board" && response.request().method() === "GET",
  );
  await page.getByRole("banner").getByRole("button", { name: "Reload", exact: true }).click();
  expect((await reloaded).status()).toBe(200);

  await page.getByRole("button", { name: "MGA-002", exact: true }).click();
  await expect(dialog).toBeVisible();
  await status.selectOption(next);
  const accepted = page.waitForResponse(
    (response) => response.url().endsWith("/api/write") && response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Save status" }).click();
  expect((await accepted).status()).toBe(200);
});
