import { expect, test } from "./fixtures";
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

test("creates, edits, persists and deletes a custom profile", async ({
  page,
}) => {
  await page.goto("./");
  await page.getByRole("tab", { name: "Configure", exact: true }).click();

  // Shipped profiles are read-only, so editing one starts from a copy.
  await page.getByRole("button", { name: "Duplicate Gravel 40 mm" }).click();
  const name = page.getByLabel("Model name");
  await expect(name).toHaveValue(/copy/i);
  await name.fill("My mountain bike");
  await page.getByLabel("Profile id").fill("my_mountain_bike");

  // Every control shows its own value — there is nothing inherited to reveal.
  await setLevel(page, "Climbing", "Prefer ++");
  // Shipped gravel already permits pushing, so turning it off is the real state change.
  await page.getByLabel("Pushing", { exact: true }).uncheck();

  await showJSON(page);
  expect(JSON.parse(await editorJSON(page).inputValue())).toMatchObject({
    format_version: 2,
    id: "my_mountain_bike",
    name: "My mountain bike",
    preferences: { climbing: "strongly_prefer" },
    permissions: { push: false },
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
  await page.getByRole("button", { name: "Duplicate Gravel 40 mm" }).click();

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
  expect(json.setup.preset).toBe("mtb_60 / expert");
});

test("imports and exports a complete profile", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("tab", { name: "Configure", exact: true }).click();

  // Export first, so the file under test is one the app itself produced.
  await page.getByRole("button", { name: "Duplicate Gravel 40 mm" }).click();
  await page.getByLabel("Profile id").fill("exported");
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
  expect(Object.keys(exported.preferences)).toHaveLength(9);
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
  await page.getByRole("button", { name: "Duplicate Gravel 40 mm" }).click();
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
