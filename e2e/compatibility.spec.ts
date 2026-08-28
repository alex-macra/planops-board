import { expect, test } from "@playwright/test";

test("retains the established dark-mode preference key", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("projects-board.dark-mode", "true");
  });

  await page.goto("/");
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await page.getByRole("button", { name: "Switch to light mode" }).click();
  expect(await page.evaluate(() => window.localStorage.getItem("projects-board.dark-mode")))
    .toBe("false");
});

test("retains the established saved-view key", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Save current" }).click();
  await page.getByLabel("Saved view name").fill("Fictional saved view");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  const saved = await page.evaluate(() =>
    window.localStorage.getItem("projects-board.saved-views.v1"));
  expect(saved).not.toBeNull();
  expect(JSON.parse(saved ?? "[]")).toEqual([
    expect.objectContaining({ name: "Fictional saved view", view: "now" }),
  ]);
});
