import {
  expect,
  test,
  saveMapData,
  planArve,
  tracksSaved,
  SAVED_TEXT,
} from "./fixtures";
test("independent tracks persist, require explicit computation, and export only current results", async ({
  page,
}) => {
  await page.goto("./");
  await saveMapData(page);
  await expect(page.getByText(SAVED_TEXT, { exact: true })).toBeVisible();
  await planArve(page);
  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  await expect(page.locator(".track-state")).toHaveText("Needs computation");
  await page.getByRole("button", { name: "Edit Track 1", exact: true }).click();
  await page
    .getByRole("button", { name: "Reprocess waypoints", exact: true })
    .click();
  await expect(page.getByText("Route ready", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  await page
    .getByRole("button", { name: "Actions for Track 1", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  await page.getByRole("tab", { name: "Configure", exact: true }).click();
  await page.getByRole("button", { name: "Road", exact: true }).click();
  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  await expect(page.locator(".track-card").first()).toContainText("Gravel");
  await expect(page.locator(".track-card").nth(1)).toContainText("Road");
  await expect(page.locator(".track-card").nth(1)).toContainText(
    "Needs computation",
  );
  await page
    .getByRole("button", { name: "Actions for Track 1 copy", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Export GPX" }),
  ).toHaveAttribute("data-disabled", "");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Compute active track", exact: true })
    .click();
  await expect(page.locator(".track-card").nth(1)).toContainText("Ready");
  await tracksSaved(page);
  await page.reload();
  await expect(page.locator(".track-card")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Select Track 1 copy", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  // Export sits with the route it exports, in the Edit tab.
  await page.getByRole("tab", { name: "Edit", exact: true }).click();
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export your route" }).click();
  const file = await event;
  expect(file.suggestedFilename()).toBe("Track-1-copy.gpx");
});
