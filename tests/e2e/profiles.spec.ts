import { expect, startTrack, test } from "./fixtures";
import type { Page } from "@playwright/test";

const editorJSON = (page: Page) =>
  page.getByLabel("Profile JSON", { exact: true });

async function showJSON(page: Page) {
  const summary = page.locator(".profile-editor-panel > details > summary", {
    hasText: "Profile JSON",
  });
  if ((await summary.locator("xpath=..").getAttribute("open")) === null)
    await summary.click();
}

/** Click one of the five words in a preference row. */
const setLevel = (page: Page, field: string, level: string) =>
  page
    .locator(".field", { has: page.getByText(field, { exact: true }) })
    .getByRole("radio", { name: level, exact: true })
    .click();

test("an open edit holds the model list until it is saved or cancelled", async ({
  page,
}) => {
  await page.goto("./");
  await page.getByRole("tab", { name: "Configure", exact: true }).click();
  const rows = page.locator(".model-list .model-row");
  await page
    .getByRole("button", { name: "Duplicate Gravel", exact: true })
    .click();
  await expect(page.getByLabel("Model name")).toHaveValue(/copy/i);
  // Picking another model now would leave the editor showing a model the track no longer uses.
  for (const row of await rows.all()) await expect(row).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Duplicate Gravel", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("Model name")).toBeHidden();
  for (const row of await rows.all()) await expect(row).toBeEnabled();
});

test("creates, edits, persists and deletes a custom profile", async ({
  page,
}) => {
  await page.goto("./");
  // Saving a model applies it to the active track, so there has to be one.
  await startTrack(page);
  await page.getByRole("tab", { name: "Configure", exact: true }).click();

  // Shipped profiles are read-only, so editing one starts from a copy.
  await page
    .getByRole("button", { name: "Duplicate Gravel", exact: true })
    .click();
  const name = page.getByLabel("Model name");
  await expect(name).toHaveValue(/copy/i);
  await name.fill("My mountain bike");

  // Every control shows its own value — there is nothing inherited to reveal.
  await setLevel(page, "Climbing", "Prefer ++");
  // Shipped gravel does not permit pushing, so turning it on is the real state change.
  await page.getByLabel("Pushing", { exact: true }).check();

  await showJSON(page);
  expect(JSON.parse(await editorJSON(page).inputValue())).toMatchObject({
    format_version: 3,
    // Generated, never typed: a duplicate cannot collide with the profile it came from.
    id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/),
    name: "My mountain bike",
    settings: { climbing: "strongly_prefer" },
    permissions: { push: true },
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
  await page.getByRole("button", { name: "Edit My mountain bike" }).click();
  await expect(
    page
      .locator(".field", { has: page.getByText("Climbing", { exact: true }) })
      .getByRole("radio", { name: "Prefer ++", exact: true }),
  ).toHaveAttribute("aria-checked", "true");

  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Delete My mountain bike" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(page.getByText("Deleted.", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit My mountain bike" }),
  ).toHaveCount(0);
});

test("shows what the bike and rider add up to", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("tab", { name: "Configure", exact: true }).click();
  await page
    .getByRole("button", { name: "Duplicate Gravel", exact: true })
    .click();

  // The readout is the answer to "inheritance doesn't show values": the setup feeds a
  // model, and the model says out loud what it concluded.
  const readout = page.locator(".capability-readout");
  await expect(readout).toContainText(/Climbs comfortably to \d+%/);
  const before = await readout.textContent();

  // Changing the bike changes the conclusion, and detaches the preset label.
  await page.getByLabel("Bike", { exact: true }).selectOption("mtb_60");
  await expect(readout).not.toHaveText(before!);
  await showJSON(page);
  const json = JSON.parse(await editorJSON(page).inputValue());
  expect(json.setup.bike.tire_mm).toBe(60);
  // The label follows the numbers: the bike is now a preset, the rider may not be.
  expect(json.setup.preset).toMatch(/^(mtb_60 \/ \w+|custom)$/);
});

test("imports and exports a complete profile", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("tab", { name: "Configure", exact: true }).click();

  // Export first, so the file under test is one the app itself produced.
  await page
    .getByRole("button", { name: "Duplicate Gravel", exact: true })
    .click();
  await page.getByLabel("Model name").fill("Exported");
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("exported.profile.json");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const exported = JSON.parse(Buffer.concat(chunks).toString());

  // The whole point of the format: what comes out is complete and self-contained, so it
  // can go straight back in without a master file to resolve it against.
  expect(Object.keys(exported.settings)).toHaveLength(4);
  expect(Object.keys(exported.preferences.base)).toHaveLength(6);
  expect(exported.setup.bike.lowest_gear_ratio).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByLabel("Import profile JSON").setInputFiles({
    name: "exported.profile.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ ...exported, name: "Round trip" })),
  });
  await expect(page.getByLabel("Model name")).toHaveValue("Round trip");
  await page.getByRole("button", { name: "Save and use" }).click();
  await expect(
    page.getByText("Saved Round trip.", { exact: true }),
  ).toBeVisible();
});

test("reports an invalid profile instead of saving it", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("tab", { name: "Configure", exact: true }).click();
  await page
    .getByRole("button", { name: "Duplicate Gravel", exact: true })
    .click();
  await showJSON(page);
  // A partial profile is rejected rather than filled in from somewhere else — which is
  // exactly what the old format did, and why a shared file meant nothing on its own.
  await editorJSON(page).fill(
    JSON.stringify({
      format_version: 2,
      id: "broken",
      name: "Broken",
      preferences: { detour: "prefer" },
    }),
  );
  await page.getByRole("button", { name: "Save and use" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit Broken" })).toHaveCount(
    0,
  );
});
