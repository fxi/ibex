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
  // Every feature carries the paint properties the layers read.
  for (const f of features) {
    expect(String(f.color)).toMatch(/^#[0-9a-f]{6}$/i);
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
  expect(await page.getByTestId("map-error").count()).toBe(0);
});
