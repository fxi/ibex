import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

const openEditorJSON = (page: Page) =>
  page.getByLabel("Profile JSON", { exact: true });

async function showJSON(page: Page) {
  const summary = page.locator(".profile-editor-panel > details > summary", {
    hasText: "Profile JSON",
  });
  if ((await summary.locator("xpath=..").getAttribute("open")) === null)
    await summary.click();
}

test("creates, edits, persists and deletes a custom profile", async ({
  page,
}) => {
  await page.goto("./");
  await page.getByRole("tab", { name: "Configure", exact: true }).click();

  // Presets are read-only, so editing one starts from a copy.
  await page.getByRole("button", { name: "Duplicate gravel" }).click();
  const name = page.getByLabel("Model name");
  await expect(name).toHaveValue(/copy/i);
  await name.fill("My mountain bike");

  // A field starts inherited and becomes explicit only once it is set.
  const climbing = page.getByLabel("Climbing", { exact: true });
  const climbingField = page.locator(".field", { has: climbing });
  await expect(climbingField).toHaveClass(/inherited/);
  await climbing.fill("80");
  await expect(climbingField).not.toHaveClass(/inherited/);

  await page.getByLabel("Hike-a-bike", { exact: true }).check();

  await showJSON(page);
  expect(JSON.parse(await openEditorJSON(page).inputValue())).toMatchObject({
    name: "My mountain bike",
    bike: "gravel",
    attraction: { climbing: 80 },
    access: { hike_a_bike: true },
  });

  await page.getByRole("button", { name: "Save and use" }).click();
  await expect(
    page.getByText("Saved My mountain bike.", { exact: true }),
  ).toBeVisible();

  // Saving applies it to the active track.
  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  await expect(page.locator(".track-card").first()).toContainText(
    "My mountain bike",
  );

  await page.reload();
  await page.getByRole("tab", { name: "Configure", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Edit My mountain bike" }),
  ).toBeVisible();

  // Reopening shows the saved values, with untouched fields still inherited.
  await page.getByRole("button", { name: "Edit My mountain bike" }).click();
  await expect(page.getByLabel("Climbing", { exact: true })).toHaveValue("80");
  await expect(
    page.locator(".field", { has: page.getByLabel("Scenic", { exact: true }) }),
  ).toHaveClass(/inherited/);

  // Resetting a field returns it to inheriting the preset.
  await climbingField.getByRole("button", { name: "Reset" }).click();
  await expect(climbingField).toHaveClass(/inherited/);

  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Delete My mountain bike" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(
    page.getByText("Deleted My mountain bike.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit My mountain bike" }),
  ).toHaveCount(0);
});

test("keeps an explicit no-limit distinct from an inherited value", async ({
  page,
}) => {
  await page.goto("./");
  await page.getByRole("tab", { name: "Configure", exact: true }).click();
  await page.getByRole("button", { name: "Duplicate road" }).click();
  await page.getByLabel("Model name").fill("No limits");

  // Every bike inherits "no limit" by default, so this starts by setting a real limit
  // and then makes the absence of one an explicit choice rather than an inherited one.
  const grade = page.getByLabel("Max grade up", { exact: true });
  const field = page.locator(".field", { has: grade });
  await expect(field).toHaveClass(/inherited/);
  await field.getByRole("button", { name: "Set a limit" }).click();
  await expect(field).not.toHaveClass(/inherited/);
  await grade.fill("15");
  await expect(field.locator("output")).toHaveText("15");
  await field.getByRole("button", { name: "No limit" }).click();
  await expect(field.locator("output")).toHaveText("no limit");
  await expect(field).not.toHaveClass(/inherited/);

  await page.getByRole("button", { name: "Save and use" }).click();
  await expect(page.getByText("Saved No limits.", { exact: true })).toBeVisible();

  await page.reload();
  await page.getByRole("tab", { name: "Configure", exact: true }).click();
  await page.getByRole("button", { name: "Edit No limits" }).click();
  const reopened = page.locator(".field", {
    has: page.getByLabel("Max grade up", { exact: true }),
  });
  await expect(reopened).toContainText("no limit");
  // Explicit, not merely inherited from the bike.
  await expect(reopened).not.toHaveClass(/inherited/);
  await showJSON(page);
  expect(JSON.parse(await openEditorJSON(page).inputValue())).toMatchObject({
    capabilities: { max_grade_up: null },
  });
});

test("imports and exports profile JSON", async ({ page }) => {
  const custom = {
    version: 1,
    name: "Imported bike",
    bike: "gravel",
    attraction: { countryside: 100, cycling_network: 100 },
    access: { hike_a_bike: true, steps: true, ferry: true },
  };
  await page.goto("./");
  await page.getByRole("tab", { name: "Configure", exact: true }).click();
  await page.getByLabel("Import profile JSON").setInputFiles({
    name: "profile.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(custom)),
  });
  await expect(page.getByLabel("Model name")).toHaveValue("Imported bike");
  await expect(page.getByLabel("Ferry", { exact: true })).toBeChecked();

  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("Imported-bike.json");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual(custom);

  await page.getByRole("button", { name: "Save and use" }).click();
  await expect(
    page.getByText("Saved Imported bike.", { exact: true }),
  ).toBeVisible();
});

test("reports an invalid profile instead of saving it", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("tab", { name: "Configure", exact: true }).click();
  await page.getByRole("button", { name: "Duplicate gravel" }).click();
  await page.getByLabel("Model name").fill("Broken");
  await showJSON(page);
  // The raw JSON escape hatch can still express something the schema rejects.
  await openEditorJSON(page).fill(
    JSON.stringify({
      version: 1,
      name: "Broken",
      bike: "gravel",
      attraction: { quet: 10 },
    }),
  );
  await page.getByRole("button", { name: "Save and use" }).click();
  await expect(page.getByRole("alert")).toContainText("quet");
  await expect(
    page.getByRole("button", { name: "Edit Broken" }),
  ).toHaveCount(0);
});
