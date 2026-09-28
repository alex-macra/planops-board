import { expect, type Page } from "@playwright/test";

// Now regroups a row once the history summary lands, so interact only after the
// row shows its age when a test depends on the row's final group.
export async function expectNowHistoryLanded(page: Page, taskId: string): Promise<void> {
  await expect(
    page.getByRole("button", { name: new RegExp(`^${taskId}\\b`) }).filter({ hasText: /\d+d untouched/ }),
  ).toBeVisible();
}
