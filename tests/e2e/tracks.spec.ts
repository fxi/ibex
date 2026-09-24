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
  await page.getByRole("button", { name: "Compute", exact: true }).click();
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
  await page.getByRole("tab", { name: "Edit", exact: true }).click();
  await page
    .getByRole("button", { name: "Compute active track", exact: true })
    .click();
  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
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

test("a track is hidden from its card, and the others all at once from its menu", async ({
  page,
}) => {
  await page.goto("./");
  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  for (let i = 0; i < 3; i++)
    await page.getByRole("button", { name: "New track", exact: true }).click();
  const states = page.locator(".track-state");
  const hidden = () => states.filter({ hasText: /^Hidden/ });

  await page.getByRole("button", { name: "Hide Track 2", exact: true }).click();
  await expect(states.nth(1)).toHaveText(/^Hidden · /);
  await expect(
    page.getByRole("button", { name: "Show Track 2", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Show Track 2", exact: true }).click();
  await expect(hidden()).toHaveCount(0);

  await page
    .getByRole("button", { name: "Actions for Track 1", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Hide all others" }).click();
  await expect(hidden()).toHaveCount(2);
  await expect(states.first()).not.toHaveText(/^Hidden/);

  await page
    .getByRole("button", { name: "Actions for Track 1", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Hide all others" }),
  ).toHaveAttribute("data-disabled", "");
  await page.getByRole("menuitem", { name: "Show all others" }).click();
  await expect(hidden()).toHaveCount(0);
});

test("the list menu sorts the tracks and deletes them all after asking", async ({
  page,
}) => {
  await page.goto("./");
  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  for (let i = 0; i < 2; i++)
    await page.getByRole("button", { name: "New track", exact: true }).click();
  // Only the active card, the last one added, shows its name field.
  await page.getByLabel("Track name").fill("Aosta");
  const names = page.locator(".track-copy strong");
  await expect(names).toHaveText(["Track 1", "Aosta"]);

  const menu = page.getByRole("button", { name: "Track list actions" });
  await menu.click();
  await page.getByRole("menuitemradio", { name: "Name" }).click();
  await expect(names).toHaveText(["Aosta", "Track 1"]);

  await menu.click();
  await page.getByRole("menuitem", { name: "Delete all" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".track-card")).toHaveCount(2);
  await menu.click();
  await page.getByRole("menuitem", { name: "Delete all" }).click();
  await dialog.getByRole("button", { name: "Delete all" }).click();
  await expect(page.locator(".track-card")).toHaveCount(0);
});
