import type { Page } from "@playwright/test";
import { test, expect, saveMapData, planArve, tracksSaved } from "./fixtures";

async function arveRoute(page: Page) {
  await page.goto("./");
  await saveMapData(page);
  await planArve(page);
  await page
    .getByRole("button", { name: "Compute active track", exact: true })
    .click();
  await expect(page.getByText(/^Route ready/)).toBeVisible();
}

/** A point on the active route, by fraction of its vertices. */
const routePoint = (page: Page, fraction: number) =>
  page.locator(".map").evaluate(async (element, fraction) => {
    const map = (element as HTMLElement & { _map: any })._map;
    const geometry: [number, number][] = (
      await map.getSource("route").getData()
    ).features.flatMap((f: any) => f.geometry.coordinates);
    return geometry[Math.floor((geometry.length - 1) * fraction)];
  }, fraction);

/** Open the map menu at a place, as a right-click or long-press would. */
const openMenu = (page: Page, [lng, lat]: [number, number]) =>
  page.locator(".map").evaluate(
    (element, [lng, lat]) => {
      const map = (element as HTMLElement & { _map: any })._map;
      map.jumpTo({ center: [lng, lat] });
      map.fire("contextmenu", {
        point: map.project([lng, lat]),
        lngLat: { lng, lat },
        preventDefault: () => {},
        originalEvent: {},
      });
    },
    [lng, lat],
  );

test("a note added from the map menu is listed along the route and kept", async ({
  page,
}) => {
  await arveRoute(page);
  await openMenu(page, await routePoint(page, 0.5));
  await page
    .getByRole("button", { name: "Add note here", exact: true })
    .click();
  await expect(page.getByRole("tab", { name: "Notes" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const text = page.getByRole("textbox", { name: "Note text" });
  await expect(text).toBeFocused();
  await text.fill("Lunch by the river");
  await text.press("Enter");
  await expect(page.locator(".place")).toContainText(/\d+\.\d km/);
  await tracksSaved(page);
  await page.reload();
  await page.getByRole("tab", { name: "Notes", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Note text" })).toHaveValue(
    "Lunch by the river",
  );
});

test("places found along the route are listed, and a search area limits the next one", async ({
  page,
  browserName,
}) => {
  // The query is a main-thread fetch, but WebKit's routing of anything near the service
  // worker is unreliable on Linux CI (AGENTS.md), and the parsing is covered by unit tests.
  test.skip(browserName === "webkit", "WebKit routes mocks unreliably");
  await arveRoute(page);
  const [lng, lat] = await routePoint(page, 0.3);
  const queries: string[] = [];
  await page.route("https://overpass-api.de/**", async (route) => {
    queries.push(
      new URLSearchParams(route.request().postData() ?? "").get("data") ?? "",
    );
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        elements: [
          {
            type: "node",
            id: 42,
            lat: lat + 0.001,
            lon: lng,
            tags: { shop: "bakery", name: "Boulangerie de l'Arve" },
          },
          {
            type: "node",
            id: 43,
            lat: lat + 0.3,
            lon: lng,
            tags: { amenity: "drinking_water" },
          },
        ],
      }),
    });
  });
  await page.getByRole("tab", { name: "Notes", exact: true }).click();
  await page.getByRole("button", { name: "Find along route" }).click();
  await expect(page.locator(".place")).toHaveCount(1);
  await expect(page.locator(".place")).toContainText("Boulangerie de l'Arve");
  await expect(page.locator(".place")).toContainText(/\d+\.\d km/);
  expect(queries[0]).toMatch(/^\[out:json\].*nwr\(around:\d+,/);

  await openMenu(page, [lng, lat]);
  await page
    .getByRole("button", { name: "Find places around here", exact: true })
    .click();
  await page.getByRole("button", { name: "Search area" }).click();
  await expect(page.locator(".place")).toHaveCount(1);
  expect(queries).toHaveLength(2);

  await page.getByRole("button", { name: "Clear places" }).click();
  await expect(page.locator(".place")).toHaveCount(0);
});
