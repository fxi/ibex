import { expect, test, saveMapData, SAVED_TEXT } from "./fixtures";

/** Read back what the map source actually holds, rather than guessing from pixels. */
async function routeFeatures(page: import("@playwright/test").Page) {
  // getStyle() serialises GeoJSON sources with their data, so this is viewport
  // independent — unlike querying rendered features.
  return page.evaluate(() => {
    const map = (
      document.querySelector(".map") as HTMLElement & {
        _map?: {
          getStyle: () => {
            sources: Record<string, { data?: unknown }>;
          };
        };
      }
    )?._map;
    const data = map?.getStyle().sources.route?.data as
      | { features?: { properties: Record<string, unknown> }[] }
      | undefined;
    return (data?.features ?? []).map((f) => f.properties);
  });
}

test("a computed route is drawn as its rideability classes", async ({
  page,
}) => {
  await page.goto("./");
  await saveMapData(page);
  await expect(page.getByText(SAVED_TEXT, { exact: true })).toBeVisible({
    timeout: 60000,
  });

  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  await page.getByRole("button", { name: "Along the Arve" }).click();
  await page
    .getByRole("button", { name: "Reprocess waypoints", exact: true })
    .click();
  await expect(page.getByText("Route ready", { exact: true })).toBeVisible({
    timeout: 90000,
  });

  // The fixture mixes paved and gravel, so the legend appears and names both.
  const legend = page.locator(".ride-legend");
  await expect(legend).toBeVisible();
  await expect(legend).toContainText("Paved");
  await expect(legend).toContainText("Gravel");

  const features = await routeFeatures(page);
  expect(features.length).toBeGreaterThan(1);
  const classes = new Set(features.map((f) => f.ride));
  expect(classes.has("paved")).toBe(true);
  expect(classes.has("gravel")).toBe(true);
  // Every feature carries the paint properties the layers read, and every one of them
  // carries the same track colour: colour says which track, never what it is made of.
  const colors = new Set(features.map((f) => String(f.trackColor)));
  expect(colors.size).toBe(1);
  for (const f of features) {
    expect(String(f.trackColor)).toMatch(/^#[0-9a-f]{6}$/i);
    expect(typeof f.active).toBe("boolean");
    expect(typeof f.stale).toBe("boolean");
  }

  // The dedicated overlay layers exist for the rougher classes.
  const layers = await page.evaluate(
    () =>
      (
        document.querySelector(".map") as HTMLElement & {
          _map?: { getStyle: () => { layers: { id: string }[] } };
        }
      )?._map
        ?.getStyle()
        .layers.map((l) => l.id),
  );
  expect(layers).toContain("route-gravel");
  expect(layers).toContain("route-walk");
  // Paved is drawn clean, so it must not have a centre-line layer of its own.
  expect(layers).not.toContain("route-paved");
  expect(await page.getByTestId("map-error").count()).toBe(0);

  // The Legend tab explains the two channels and lists the classes it just drew.
  await page.getByRole("tab", { name: "Legend", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Symbology" })).toBeVisible();
  const surfaces = page.locator(".symbology-list").first();
  await expect(surfaces).toContainText("Paved");
  await expect(surfaces).toContainText("Hike-a-bike");
  await expect(surfaces).toContainText("Surface unknown");
});
