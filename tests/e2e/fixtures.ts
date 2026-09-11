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
