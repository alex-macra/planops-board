import { expect, test } from "@playwright/test";

test.setTimeout(60_000);

test("edits, undoes, annotates, branches, and commits a fictional task", async ({ page }) => {
  const foreign = await page.request.get("/api/session", {
    headers: { Origin: "https://example.invalid" },
  });
  expect(foreign.status()).toBe(403);

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "PlanOps Board" })).toBeVisible();
  await expect(page.getByText("9 tasks", { exact: true })).toBeVisible();

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
