import { expect, test, saveMapData, planArve, SAVED_TEXT } from "./fixtures";

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

  await planArve(page);
  await page
    .getByRole("button", { name: "Compute", exact: true })
    .click();
  await expect(page.getByText("Route ready", { exact: true })).toBeVisible({
    timeout: 90000,
  });

  // The fixture mixes paved and gravel, so the composition names both. What the route is
  // made of is read in the Edit tab, next to the controls that shaped it.
  await page.getByRole("tab", { name: "Edit", exact: true }).click();
  const composition = page.locator(".composition-legend");
  await expect(composition).toBeVisible();
  await expect(composition).toContainText("Paved");
  await expect(composition).toContainText("Gravel");
  await expect(composition).toContainText("%");
  await expect(page.locator(".composition-bar")).toBeVisible();

  // One signal at a time under the curve, and the caption says which one, so the prose and
  // the picture cannot drift apart.
  const switcher = page.locator(".lane-switcher");
  const caption = page.locator(".stats .elevation figcaption");
  await expect(switcher.getByRole("button")).toHaveCount(3);
  await expect(caption).toContainText("Surface:");
  const steep = switcher.getByRole("button", { name: "Steep", exact: true });
  await steep.click();
  await expect(steep).toHaveAttribute("aria-pressed", "true");
  await expect(caption).toContainText("Steep:");

  // Traffic stress reaches the chart only because the engine now stores it per segment.
  const traffic = switcher.getByRole("button", { name: "Traffic", exact: true });
  await traffic.click();
  await expect(traffic).toHaveAttribute("aria-pressed", "true");
  await expect(steep).toHaveAttribute("aria-pressed", "false");
  await expect(caption).toContainText("Traffic:");

  // The waypoint list moved here from the card: numbered like the markers, each with its
  // distance along the route and a way to drop it.
  const rows = page.locator(".stats .waypoint");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("km");
  await expect(
    page.getByRole("button", { name: "Remove waypoint 2", exact: true }),
  ).toBeVisible();

  // Waypoints and warnings are marked along the top of the detailed profile, and nowhere
  // near the card's sparkline.
  expect(await page.locator(".stats .elevation .pin-head").count()).toBeGreaterThan(0);

  // Pointing at a row puts exactly one mark on the map. The dot is a circle layer rather
  // than a DOM marker, so it pans and zooms with the map and nothing tracks a transform.
  // Read through getStyle(), the public API this spec already uses for layers, rather than
  // a source's private fields: an internal that happens to be undefined would make the
  // "nothing marked yet" check pass for the wrong reason.
  const cursorFeatures = () =>
    page.evaluate(() => {
      const source = (
        document.querySelector(".map") as HTMLElement & {
          _map?: {
            getStyle: () => {
              sources: Record<string, { data?: { features?: unknown[] } }>;
            };
          };
        }
      )?._map?.getStyle()?.sources?.cursor;
      return source?.data?.features?.length ?? -1;
    });
  expect(await cursorFeatures()).toBe(0);
  const locate = page.locator(".locate-button").first();
  if (await locate.count()) {
    await locate.click();
    await expect.poll(cursorFeatures).toBe(1);
  }

  // A drag across the chart narrows to a stretch, where a press points at a place: the two
  // share one overlay and are told apart by how far the pointer travelled.
  const chart = page.locator(".stats .elevation svg");
  // An earlier locate click may have scrolled the panel down to the waypoint list.
  await chart.scrollIntoViewIfNeeded();
  const chartBox = (await chart.boundingBox())!;
  const midY = chartBox.y + chartBox.height / 2;
  await page.mouse.move(chartBox.x + chartBox.width * 0.3, midY);
  await page.mouse.down();
  await page.mouse.move(chartBox.x + chartBox.width * 0.75, midY, {
    steps: 8,
  });
  await page.mouse.up();
  const controls = page.locator(".range-controls");
  await expect(controls).toContainText("Showing");
  await controls.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(controls).toHaveCount(0);

  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  // The card's sparkline is the same component without the detail prop: no switcher, so
  // the exclusion is structural rather than something a stylesheet could undo.
  await expect(page.locator(".sparkline")).toBeVisible();
  await expect(page.locator(".sparkline .lane-switcher")).toHaveCount(0);

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
