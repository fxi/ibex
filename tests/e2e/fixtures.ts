import { test as base, expect, type Page } from "@playwright/test";
export { expect };

/** The single cell in `public/packs/cell-fixture`, as the Data tab labels it. */
export const FIXTURE_CELL = "9/264/181";
/** The Data tab readiness line once at least one area is installed and routable. */
export const SAVED_TEXT = "1 area ready for offline routing";

/**
 * Select the fixture area on the map grid and run the pending change. Kept here so the
 * Data tab can be reshaped without editing every spec.
 */
export async function saveMapData(page: Page) {
  await page.getByRole("tab", { name: "Data", exact: true }).click();
  const process = page.getByRole("button", { name: /^Process \d+ cell/ });
  if (!(await process.isVisible())) {
    const ready =
      (await page.locator(".map").getAttribute("data-ready")) === "true";
    if (ready) {
      // The default camera sits inside the fixture cell; this upper-left point is
      // clear of the control column and the planner panel on either viewport.
      const box = (await page.locator(".map").boundingBox())!;
      await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
    } else {
      // No basemap (no MapTiler key): the list is the accessible equivalent.
      await page.locator(".all-areas > summary").click();
      await page
        .getByRole("button", { name: `Select area ${FIXTURE_CELL}` })
        .click();
    }
  }
  await process.click();
}
/** Two waypoints along the Arve, inside the fixture cell. */
export const ARVE: [number, number][] = [
  [6.146, 46.189],
  [6.235, 46.177],
];

/**
 * Start a track and place the Arve waypoints as map clicks on the Edit tab — the only tab
 * where the map takes edits — then fit the map to them. Leaves the page on the Edit tab,
 * where computing, exporting and undo live. Expects a fresh page with no track yet.
 */
export async function planArve(page: Page) {
  const card = page.locator(".track-card.open");
  const hasMap = await page
    .locator(".map")
    .evaluate((e) => !!(e as HTMLElement & { _map?: unknown })._map);
  if (!hasMap) {
    // No basemap means no map clicks. Store the anchors as an older single plan instead,
    // which a load with no saved collection migrates into a track.
    await tracksSaved(page);
    await page.evaluate(async (anchors) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open("cyclatractor-v1");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("preferences", "readwrite");
        tx.objectStore("preferences").delete("ibex-tracks");
        tx.objectStore("preferences").put({ anchors }, "plan");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    }, ARVE);
    await page.reload();
    await page.getByRole("tab", { name: "Tracks", exact: true }).click();
    await expect(card).toContainText(`${ARVE.length} waypoints`);
    await page.getByRole("tab", { name: "Edit", exact: true }).click();
    return;
  }
  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  await page
    .getByRole("button", { name: "No track, add one to start" })
    .click();
  await page.getByRole("tab", { name: "Edit", exact: true }).click();
  // One click per render: the map handler appends to the anchors it last saw.
  for (const [i, [lng, lat]] of ARVE.entries()) {
    await page.locator(".map").evaluate(
      (element, [lng, lat]) => {
        const map = (element as HTMLElement & { _map: any })._map;
        map.fire("click", {
          lngLat: { lng, lat },
          point: map.project([lng, lat]),
          originalEvent: {},
        });
      },
      [lng, lat],
    );
    await expect(
      page.getByRole("heading", { name: `Waypoints · ${i + 1}` }),
    ).toBeVisible();
  }
  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  await card.getByRole("button", { name: /^Actions for / }).click();
  await page.getByRole("menuitem", { name: "Fit to map" }).click();
  await page.getByRole("tab", { name: "Edit", exact: true }).click();
}

/** Resolves once the track collection has been written, so a reload keeps it. */
export const tracksSaved = (page: Page) =>
  expect(page.getByRole("region", { name: "Route planner" })).toHaveAttribute(
    "data-saving",
    "false",
  );

// Empty vector tiles and a transparent sprite retain the production style schema.
export const test = base.extend<{ mapResources: void }>({
  mapResources: [
    async ({ context }, use) => {
      await context.route("https://api.maptiler.com/**", async (route) => {
        const url = new URL(route.request().url());
        expect(url.pathname).not.toMatch(/\/style\.json$/);
        expect(url.searchParams.get("key")).toBe(
          "cyclatractor-browser-test-key",
        );
        if (url.pathname.endsWith("tiles.json")) {
          await route.fulfill({
            json: {
              tilejson: "3.0.0",
              tiles: ["https://api.maptiler.com/test/{z}/{x}/{y}.pbf"],
              minzoom: url.pathname.includes("terrain-rgb") ? 24 : 0,
              maxzoom: 24,
              bounds: [-180, -85, 180, 85],
            },
          });
        } else if (url.pathname.endsWith(".json")) {
          await route.fulfill({ json: {} });
        } else if (url.pathname.endsWith(".png")) {
          await route.fulfill({
            contentType: "image/png",
            body: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
              "base64",
            ),
          });
        } else {
          await route.fulfill({
            contentType: "application/x-protobuf",
            body: Buffer.alloc(0),
          });
        }
      });
      await use();
    },
    { auto: true },
  ],
});
