import { expect, test } from "./fixtures";

/**
 * Drop a waypoint at a fraction of the map's width. Kept to the left 55% and the upper
 * third so taps never land on the control column or the planner panel, which differ in
 * size between the desktop and phone viewports.
 */
async function tapMap(
  page: import("@playwright/test").Page,
  fx: number,
  fy = 0.3,
) {
  const box = (await page.locator(".map").boundingBox())!;
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
}

test("a waypoint can be inserted between two others and renumbers the rest", async ({
  page,
}) => {
  await page.goto("./");
  await expect(
    page.getByRole("heading", { name: "Your tracks" }),
  ).toBeVisible();
  await expect(page.locator(".map")).toHaveAttribute("data-ready", "true");
  // The map only takes waypoints while the Edit tab is open.
  await page.getByRole("tab", { name: "Edit", exact: true }).click();

  await tapMap(page, 0.12);
  await tapMap(page, 0.5);
  await expect(page.locator(".anchor-marker-wrap")).toHaveCount(2);

  const second = page.locator('.anchor-marker-wrap[data-index="1"]');
  await expect(second).toHaveAttribute("aria-label", "Waypoint 2");

  // Right-click waypoint 2 and arm an insertion before it.
  await second.click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Waypoint 2" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Insert waypoint before" }).click();
  await expect(page.getByText(/insert waypoint 2/i)).toBeVisible();

  await tapMap(page, 0.3);
  await expect(page.locator(".anchor-marker-wrap")).toHaveCount(3);

  // The point that was 2 is now 3: inserting before it pushed it along.
  await expect(
    page.locator('.anchor-marker-wrap[data-index="2"]'),
  ).toHaveAttribute("aria-label", "Waypoint 3");
  await expect(page.getByText(/insert waypoint/i)).toHaveCount(0);

  // The Edit tab lists the same points, beside each one's distance and height.
  const panelWaypoints = page.locator(".waypoint");
  await expect(panelWaypoints).toHaveCount(3);
});

test("a waypoint can be removed from its marker menu", async ({ page }) => {
  await page.goto("./");
  await expect(
    page.getByRole("heading", { name: "Your tracks" }),
  ).toBeVisible();
  await expect(page.locator(".map")).toHaveAttribute("data-ready", "true");
  await page.getByRole("tab", { name: "Edit", exact: true }).click();

  await tapMap(page, 0.12);
  await tapMap(page, 0.32);
  await tapMap(page, 0.52);
  await expect(page.locator(".anchor-marker-wrap")).toHaveCount(3);

  await page.locator('.anchor-marker-wrap[data-index="1"]').click({
    button: "right",
  });
  await page.getByRole("menuitem", { name: "Remove" }).click();
  await expect(page.locator(".anchor-marker-wrap")).toHaveCount(2);
  await expect(
    page.locator('.anchor-marker-wrap[data-index="1"]'),
  ).toHaveAttribute("aria-label", "Waypoint 2");
});
