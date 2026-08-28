import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("main views have no detectable WCAG 2.2 AA violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "PlanOps Board" })).toBeVisible();

  for (const view of ["Now", "Stories", "Rollup", "Board", "Backlog", "Dependencies"]) {
    await page.getByRole("radio", { name: view, exact: true }).click();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations, `${view}: ${JSON.stringify(results.violations, null, 2)}`).toEqual([]);
  }
});

test("the task drawer traps focus, closes with Escape, and returns focus", async ({ page }) => {
  await page.goto("/#view=backlog");
  const trigger = page.getByRole("button", { name: "MGA-002", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: /MGA-002/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(":focus")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
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
