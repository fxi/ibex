import { test as base, expect, type Page } from "@playwright/test";
export { expect };

/** The single cell in `tests/fixtures/data`, as the Data tab labels it. */
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
      // No map: the list is the accessible equivalent.
      await page.locator(".all-areas > summary").click();
      await page
        .getByRole("button", { name: `Select area ${FIXTURE_CELL}` })
        .click();
    }
  }
  await process.click();
}
/**
 * Create the empty track a test needs to have something active, and leave the page on the
 * Tracks tab with its card open. The app starts with no track at all, so anything about
 * the active track — editing waypoints, applying a model — has to make one first.
 */
export async function startTrack(page: Page) {
  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  await page.getByRole("button", { name: "No track, add one to start" }).click();
  await expect(page.locator(".track-card.open")).toBeVisible();
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
    // No basemap means no map clicks. Create the track through the UI, then write the
    // anchors into the saved collection, which the reload restores.
    await page.getByRole("tab", { name: "Tracks", exact: true }).click();
    await page
      .getByRole("button", { name: "No track, add one to start" })
      .click();
    await expect(card).toBeVisible();
    await tracksSaved(page);
    await page.evaluate(async (anchors) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open("ibex");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("preferences", "readwrite");
        const store = tx.objectStore("preferences");
        const read = store.get("ibex-tracks");
        read.onsuccess = () => {
          const collection = read.result;
          collection.tracks[0].anchors = anchors;
          collection.tracks[0].revision += 1;
          store.put(collection, "ibex-tracks");
        };
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

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
  "base64",
);

/** Imagery hosts, read only by the satellite and hybrid base maps. */
export const IMAGERY_HOSTS = [
  "https://tiles.maps.eox.at/**",
  "https://data.geopf.fr/**",
  "https://wmts.geo.admin.ch/**",
];

// Everything else the map reads is a file in the fixture tree: WebKit does not route the
// service worker's or a web worker's requests, so a mock there is only sometimes seen.
// Imagery stays mocked because only the hybrid test draws it, and it asserts layers, not
// pixels.
export const test = base.extend<{ mapResources: void }>({
  mapResources: [
    async ({ context }, use) => {
      for (const host of IMAGERY_HOSTS)
        await context.route(host, (route) =>
          route.fulfill({ contentType: "image/png", body: PIXEL }),
        );
      await use();
    },
    { auto: true },
  ],
});
