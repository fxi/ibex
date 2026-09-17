import { expect, test } from "./fixtures";

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Sunday loop</name><trkseg>
    <trkpt lat="46.189" lon="6.146"><ele>400</ele></trkpt>
    <trkpt lat="46.183" lon="6.170"><ele>430</ele></trkpt>
    <trkpt lat="46.177" lon="6.235"><ele>410</ele></trkpt>
  </trkseg></trk>
</gpx>`;

test("imports a GPX file as a reference track that exports again", async ({
  page,
}) => {
  await page.goto("./");
  await expect(
    page.getByRole("heading", { name: "Your tracks" }),
  ).toBeVisible();

  await page.getByRole("tab", { name: "Tools", exact: true }).click();
  await page.getByLabel("Import tracks").setInputFiles({
    name: "sunday-loop.gpx",
    mimeType: "application/gpx+xml",
    buffer: Buffer.from(GPX),
  });

  // Importing switches to Tracks and selects the new track.
  await expect(page.getByRole("heading", { name: "Your tracks" })).toBeVisible();
  const card = page.locator(".track-card", { hasText: "Sunday loop" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Imported");
  await expect(card).toContainText("Reference");

  // It draws on the map.
  await expect(card.locator(".sparkline")).toBeVisible();

  // A reference track is never routed, so its Edit tab offers no routing controls.
  await card.getByRole("button", { name: "Edit Sunday loop" }).click();
  await expect(page.getByText(/kept exactly as recorded/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reprocess waypoints" }),
  ).toHaveCount(0);
  await expect(page.locator(".waypoint")).toHaveCount(0);

  // It exports back out under its own name.
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export your route" }).click();
  expect((await download).suggestedFilename()).toBe("Sunday-loop.gpx");
});

test("reports a bad import without adding a track", async ({ page }) => {
  await page.goto("./");
  await expect(
    page.getByRole("heading", { name: "Your tracks" }),
  ).toBeVisible();
  // Tracks load asynchronously; count only once the default track is on screen.
  await expect(page.locator(".track-card")).toHaveCount(1);
  const before = await page.locator(".track-card").count();

  await page.getByRole("tab", { name: "Tools", exact: true }).click();
  await page.getByLabel("Import tracks").setInputFiles({
    name: "notes.gpx",
    mimeType: "application/gpx+xml",
    buffer: Buffer.from("<html><body>not a track</body></html>"),
  });

  await expect(page.getByRole("alert")).toContainText("not a GPX");
  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  await expect(page.locator(".track-card")).toHaveCount(before);
});
