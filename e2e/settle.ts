import { expect, type Page } from "@playwright/test";

// Now regroups a row once the history summary lands, which remounts the row and
// closes any menu opened on it, so interact only after the row shows its age.
export async function expectNowHistoryLanded(page: Page, taskId: string): Promise<void> {
  await expect(
    page.getByRole("button", { name: new RegExp(`^${taskId}\\b`) }).filter({ hasText: /\d+d untouched/ }),
  ).toBeVisible();
}
