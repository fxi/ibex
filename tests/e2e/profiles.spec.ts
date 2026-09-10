import { expect, test } from "./fixtures";

test("saves, restores, imports, and exports custom profiles", async ({
  page,
}) => {
  await page.goto("./");
  await page.locator(".profile-editor summary").click();
  const editor = page.getByLabel("Profile JSON", { exact: true });
  const custom = {
    version: 1,
    name: "My mountain bike",
    bike: "gravel",
    attraction: { climbing: 80, quiet: 0 },
    capabilities: { max_grade_up: 15 },
    access: { hike_a_bike: true },
  };
  await editor.fill(JSON.stringify(custom));
  await page.getByRole("button", { name: "Save and use" }).click();
  await expect(
    page.getByText("Saved My mountain bike.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.locator(".profile-editor summary").click();
  await expect(page.getByLabel("Saved profiles", { exact: true })).toHaveValue(
    custom.name,
  );
  await expect
    .poll(async () => JSON.parse(await editor.inputValue()))
    .toEqual(custom);
  await page.getByRole("button", { name: "Show inherited fields" }).click();
  const expanded = JSON.parse(await editor.inputValue());
  expect(expanded.attraction.quiet).toBe(0);
  expect(expanded.costs.slope).toBe(0.65);
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("My-mountain-bike.json");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual(expanded);
  await page.getByLabel("Import JSON", { exact: true }).setInputFiles({
    name: "profile.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ ...custom, name: "Imported bike" })),
  });
  await expect(
    page.getByText("Imported. Save and use to apply.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save and use" }).click();
  await expect(page.getByLabel("Saved profiles", { exact: true })).toHaveValue(
    "Imported bike",
  );
  await editor.fill(
    JSON.stringify({
      ...custom,
      name: "All features",
      attraction: { countryside: 100, cycling_network: 100 },
      access: { hike_a_bike: true, steps: true, ferry: true },
    }),
  );
  await page.getByRole("button", { name: "Save and use" }).click();
  await expect(page.getByLabel("Saved profiles", { exact: true })).toHaveValue(
    "All features",
  );
  await editor.fill(JSON.stringify({ ...custom, attraction: { quet: 10 } }));
  await page.getByRole("button", { name: "Save and use" }).click();
  await expect(page.locator(".profile-error")).toContainText("quet");
});
