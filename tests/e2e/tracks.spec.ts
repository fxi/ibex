import { expect, test } from "./fixtures";
test("independent tracks persist, require explicit computation, and export only current results", async ({
  page,
}) => {
  await page.goto("./");
  await page.getByRole("tab", { name: "Data", exact: true }).click();
  await page.getByRole("button", { name: /Save offline/ }).click();
  await expect(
    page.getByText("Region saved offline", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  await page.getByRole("button", { name: "Along the Arve" }).click();
  await expect(page.locator(".track-state")).toHaveText("Needs computation");
  await page.getByRole("tab", { name: "Tools", exact: true }).click();
  await page
    .getByRole("button", { name: "Compute current track", exact: true })
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
  await expect(page.locator(".save-status")).toHaveText("Saved");
  await page.reload();
  await expect(page.locator(".track-card")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Select Track 1 copy", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.locator(".track-details > summary").click();
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export your route" }).click();
  const file = await event;
  expect(file.suggestedFilename()).toBe("Track-1-copy.gpx");
});

test("migrates the previous single plan once without overwriting later tracks", async ({
  page,
}) => {
  await page.goto("./");
  await expect(page.locator(".track-card")).toHaveCount(1);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("cyclatractor-v1");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("preferences", "readwrite");
      tx.objectStore("preferences").delete("ibex-tracks");
      tx.objectStore("preferences").put(
        {
          anchors: [
            [6.146, 46.189],
            [6.235, 46.177],
          ],
          profile: "road",
        },
        "plan",
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await expect(page.locator(".save-status")).toHaveText("Saved");
  await page.reload();
  await expect(page.locator(".track-card")).toContainText("Road");
  await expect(page.locator(".track-card")).toContainText("2 waypoints");
  await page.getByRole("button", { name: "New track", exact: true }).click();
  await expect(page.locator(".save-status")).toHaveText("Saved");
  await page.reload();
  await expect(page.locator(".track-card")).toHaveCount(2);
});
