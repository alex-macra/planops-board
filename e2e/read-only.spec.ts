import { expect, test } from "@playwright/test";

test("read-only Board hides edits and rejects every write endpoint", async ({ page }) => {
  test.skip(process.env["BOARD_E2E_READ_ONLY"] !== "1", "run with BOARD_E2E_READ_ONLY=1");
  const session = await page.request.get("/api/session");
  expect(session.status()).toBe(200);
  expect(await session.json()).toMatchObject({ readOnly: true, capabilities: { localWrites: false } });

  await page.goto("/#task=MGA-002");
  await expect(page.getByText(/Read-only source .* at/)).toBeVisible();
  await expect(page.getByTestId("source-revision-status")).toHaveText("Read clone is behind fetched origin/dev");
  await page.getByTestId("source-freshness").locator("summary").click();
  await expect(page.getByText("Fetched origin/dev at")).toBeVisible();
  const drawer = page.getByRole("dialog", { name: /MGA-002/ });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("combobox", { name: "Base state" })).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "Save status" })).toHaveCount(0);
  await expect(drawer.getByPlaceholder("Add a note to the Markdown ledger")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Commit changes" })).toHaveCount(0);

  const routes = ["/api/write", "/api/note", "/api/git/commit"] as const;
  const responses = await Promise.all(routes.map((route) => page.request.post(route, { data: {} })));
  expect(responses.map((response) => response.status())).toEqual([403, 403, 403]);
});
