import { readFileSync } from "node:fs";
import {
  expect,
  planArve,
  saveMapData,
  SAVED_TEXT,
  startTrack,
  test,
} from "./fixtures";

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

  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  await page.getByLabel("Import tracks").setInputFiles({
    name: "sunday-loop.gpx",
    mimeType: "application/gpx+xml",
    buffer: Buffer.from(GPX),
  });

  // Importing switches to Tracks and selects the new track.
  await expect(
    page.getByRole("heading", { name: "Your tracks" }),
  ).toBeVisible();
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
    page.getByRole("button", { name: "Compute", exact: true }),
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
  // The app starts with no track, and an empty list would pass this on its own. Start one
  // so a failed import has something it could wrongly add to.
  await startTrack(page);
  const before = await page.locator(".track-card").count();

  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  await page.getByLabel("Import tracks").setInputFiles({
    name: "notes.gpx",
    mimeType: "application/gpx+xml",
    buffer: Buffer.from("<html><body>not a track</body></html>"),
  });

  await expect(page.getByRole("alert")).toContainText("not a GPX");
  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  await expect(page.locator(".track-card")).toHaveCount(before);
});

test("an imported ride converts to a planned track that follows it", async ({
  page,
}) => {
  await page.goto("./");
  await saveMapData(page);
  await expect(page.getByText(SAVED_TEXT, { exact: true })).toBeVisible();

  // A recording on the fixture's roads: the Arve route, exported and renamed, without
  // the waypoints an export keeps, which a device's recording never has.
  await planArve(page);
  await page.getByRole("button", { name: "Compute", exact: true }).click();
  await expect(page.getByText("Route ready", { exact: true })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export your route" }).click();
  const gpx = readFileSync((await (await download).path())!, "utf8")
    .replace(/<name>[^<]*<\/name>/g, "<name>Arve ride</name>")
    .replace(/<extensions>[\s\S]*<\/extensions>/, "");

  // Imported from the Tracks toolbar.
  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  await page.getByLabel("Import tracks").setInputFiles({
    name: "arve-ride.gpx",
    mimeType: "application/gpx+xml",
    buffer: Buffer.from(gpx),
  });
  const recording = page.locator(".track-card", { hasText: "Arve ride" });
  await expect(recording).toContainText("Reference");

  // A recording is not duplicated but converted, with the profile asked for.
  await page
    .getByRole("button", { name: "Actions for Arve ride", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Duplicate", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("menuitem", { name: "Convert to planned track…" })
    .click();
  await page
    .getByLabel("Profile to convert with")
    .selectOption({ label: "Road" });
  await page.getByRole("button", { name: "Convert", exact: true }).click();

  // The new track opens in Edit, which reports the passes as they run.
  await expect(page.locator(".edit-status")).toContainText(/^Converted · /);
  await expect(page.locator(".heading-track")).toHaveText("Arve ride (ibex)");

  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  const converted = page.locator(".track-card", {
    hasText: "Arve ride (ibex)",
  });
  await expect(converted).toContainText("Road");
  await expect(converted).toContainText("Ready");
  // The recording stays, as the reference the new track is read against.
  await expect(page.locator(".track-card")).toHaveCount(3);
  await expect(
    page.locator(".track-card", { hasText: "Reference" }),
  ).toHaveCount(1);

  // The search narrows the list by name and by profile.
  const search = page.getByLabel("Search tracks");
  await search.fill("ibex");
  await expect(page.locator(".track-card")).toHaveCount(1);
  await search.fill("imported");
  await expect(page.locator(".track-card")).toHaveCount(1);
  await expect(page.locator(".track-card")).toContainText("Reference");
  await search.fill("nothing like it");
  await expect(page.locator(".track-card")).toHaveCount(0);
  await expect(page.getByText(/^No track matches/)).toBeVisible();
  await search.fill("");
  await expect(page.locator(".track-card")).toHaveCount(3);
});

test("an exported planned track imports as the planned track it was", async ({
  page,
}) => {
  await page.goto("./");
  await saveMapData(page);
  await expect(page.getByText(SAVED_TEXT, { exact: true })).toBeVisible();

  await planArve(page);
  const waypoints = await page.locator(".waypoint").count();
  expect(waypoints).toBeGreaterThan(1);
  await page.getByRole("button", { name: "Compute", exact: true }).click();
  await expect(page.getByText("Route ready", { exact: true })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export your route" }).click();
  const gpx = readFileSync((await (await download).path())!, "utf8").replace(
    /<trk><name>[^<]*<\/name>/,
    "<trk><name>Arve again</name>",
  );

  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  await page.getByLabel("Import tracks").setInputFiles({
    name: "arve-again.gpx",
    mimeType: "application/gpx+xml",
    buffer: Buffer.from(gpx),
  });

  // Not a reference: the same waypoints, routed again on the data installed here.
  const card = page.locator(".track-card", { hasText: "Arve again" });
  await expect(card).not.toContainText("Reference");
  await expect(card).toContainText("Ready");
  await card.getByRole("button", { name: "Edit Arve again" }).click();
  await expect(page.locator(".waypoint")).toHaveCount(waypoints);
});
