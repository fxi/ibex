import { expect, test, saveMapData, FIXTURE_CELL } from "./fixtures";

const openAll = async (page: import("@playwright/test").Page) => {
  await page.getByRole("tab", { name: "Data", exact: true }).click();
  const list = page.locator(".all-areas");
  if ((await list.getAttribute("open")) === null)
    await page.locator(".all-areas > summary").click();
};

test("clicking the map grid selects an area and shows the pending change", async ({
  page,
}) => {
  await page.goto("./");
  await page.getByRole("tab", { name: "Data", exact: true }).click();
  await expect(page.locator(".map")).toHaveAttribute("data-ready", "true");
  await expect(page.getByText("No pending changes")).toBeVisible();

  const box = (await page.locator(".map").boundingBox())!;
  const point: [number, number] = [
    box.x + box.width * 0.3,
    box.y + box.height * 0.3,
  ];
  await page.mouse.click(...point);
  await expect(
    page.getByRole("button", { name: /^Process 1 cell change/ }),
  ).toBeVisible();

  // Clicking the same square again clears the pending change.
  await page.mouse.click(...point);
  await expect(page.getByText("No pending changes")).toBeVisible();

  // Selecting an area must not also drop a waypoint on the Tracks tab.
  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  await expect(page.locator(".anchor-marker-wrap")).toHaveCount(0);
});

test("an installed area cycles through refresh, remove, and back", async ({
  page,
}) => {
  await page.goto("./");
  await saveMapData(page);
  await expect(
    page.getByText("1 area ready for offline routing"),
  ).toBeVisible({ timeout: 60000 });

  await openAll(page);
  const cell = page.getByRole("button", {
    name: `Select area ${FIXTURE_CELL}`,
  });
  const row = page.locator(".all-areas .cell").first();

  await expect(row).toHaveClass(/cell-installed/);
  await cell.click();
  await expect(row).toHaveClass(/cell-marked-refresh/);
  await cell.click();
  await expect(row).toHaveClass(/cell-marked-remove/);
  await cell.click();
  await expect(row).toHaveClass(/cell-installed/);
  await expect(page.getByText("No pending changes")).toBeVisible();
});

test("processing a remove intent deletes the installed area", async ({
  page,
}) => {
  await page.goto("./");
  await saveMapData(page);
  await expect(
    page.getByText("1 area ready for offline routing"),
  ).toBeVisible({ timeout: 60000 });

  await page.getByRole("button", { name: `Remove area ${FIXTURE_CELL}` }).click();
  await page.getByRole("button", { name: /^Process 1 cell change/ }).click();
  await expect(page.getByText("No areas saved yet")).toBeVisible({
    timeout: 30000,
  });
});
