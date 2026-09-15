import { test, expect, saveMapData } from "./fixtures";

// An edit reroutes only the legs it touched, and the status says how many it kept.
const routeReady = /^Route ready( · \d+ of \d+ legs reused)?$/;

test("route handle and include action insert intermediate waypoints", async ({
  page,
}) => {
  await page.goto("./");
  await saveMapData(page);
  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  await page.getByRole("button", { name: "Along the Arve" }).click();
  await page
    .getByRole("button", { name: "Compute active track", exact: true })
    .click();
  await expect(page.getByText(routeReady)).toBeVisible();
  const before = await page.locator(".anchor-marker-wrap").count();
  const point = await page.locator(".map").evaluate(async (element) => {
    const map = (element as HTMLElement & { _map: any })._map;
    const geometry = (await map.getSource("route").getData()).features.flatMap(
      (f: any) => f.geometry.coordinates,
    );
    const p = geometry[Math.floor(geometry.length / 2)];
    map.jumpTo({ center: p, zoom: 14 });
    const q = map.project(p);
    return { x: q.x, y: q.y };
  });
  // Move the route into the unoccluded upper half of the screen.
  await page.locator(".map").evaluate((element) => {
    (element as HTMLElement & { _map: any })._map.panBy([0, 150], {
      duration: 0,
    });
  });
  point.y -= 150;
  await page.mouse.move(point.x, point.y);
  await expect(page.locator(".route-drag-handle")).toBeVisible();
  await page.mouse.down();
  await page.mouse.move(point.x + 20, point.y + 10, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(".anchor-marker-wrap")).toHaveCount(before + 1);
  await expect(page.getByText(routeReady)).toBeVisible();
  await page.mouse.click(point.x - 40, point.y - 20, { button: "right" });
  await page
    .getByRole("button", { name: "Include in route", exact: true })
    .click();
  await expect(page.locator(".anchor-marker-wrap")).toHaveCount(before + 2);
  // Including a point splits one of the two legs; the other is reused, not rerouted.
  await expect(
    page.getByText("Route ready · 1 of 3 legs reused", { exact: true }),
  ).toBeVisible();
  const canvas = page.locator(".map canvas");
  const touch = { identifier: 0, clientX: point.x - 60, clientY: point.y - 30 };
  await canvas.dispatchEvent("touchstart", {
    touches: [touch],
    changedTouches: [touch],
  });
  await expect(
    page.getByRole("button", { name: "Include in route", exact: true }),
  ).toBeVisible();
  await canvas.dispatchEvent("touchend", {
    touches: [],
    changedTouches: [touch],
  });
  await page
    .getByRole("button", { name: "Include in route", exact: true })
    .click();
  await expect(page.locator(".anchor-marker-wrap")).toHaveCount(before + 3);
});

test("right-click on the route opens the menu over the drag handle", async ({
  page,
}) => {
  await page.goto("./");
  await saveMapData(page);
  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  await page.getByRole("button", { name: "Along the Arve" }).click();
  await page
    .getByRole("button", { name: "Compute active track", exact: true })
    .click();
  await expect(page.getByText(routeReady)).toBeVisible();
  const point = await page.locator(".map").evaluate(async (element) => {
    const map = (element as HTMLElement & { _map: any })._map;
    const geometry = (await map.getSource("route").getData()).features.flatMap(
      (f: any) => f.geometry.coordinates,
    );
    const p = geometry[Math.floor(geometry.length / 2)];
    map.jumpTo({ center: p, zoom: 14 });
    map.panBy([0, 150], { duration: 0 });
    const q = map.project(p);
    return { x: q.x, y: q.y };
  });
  await page.mouse.move(point.x, point.y);
  await expect(page.locator(".route-drag-handle")).toBeVisible();
  await page.mouse.click(point.x, point.y, { button: "right" });
  await expect(
    page.getByRole("button", { name: "Include in route", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open in Street View", exact: true }),
  ).toBeVisible();
});

test("Street View is offered only on a computed route", async ({ page }) => {
  await page.goto("./");
  await saveMapData(page);
  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  await page.getByRole("button", { name: "Along the Arve" }).click();
  await page
    .getByRole("button", { name: "Compute active track", exact: true })
    .click();
  await expect(page.getByText(routeReady)).toBeVisible();
  // Off the Tracks tab the include action is gone, so only Street View can appear.
  await page.getByRole("tab", { name: "Legend", exact: true }).click();
  const point = await page.locator(".map").evaluate(async (element) => {
    const map = (element as HTMLElement & { _map: any })._map;
    const geometry = (await map.getSource("route").getData()).features.flatMap(
      (f: any) => f.geometry.coordinates,
    );
    const p = geometry[Math.floor(geometry.length / 2)];
    map.jumpTo({ center: p, zoom: 14 });
    map.panBy([0, 150], { duration: 0 });
    const q = map.project(p);
    return { x: q.x, y: q.y };
  });
  await page.evaluate(() => {
    window.open = (url) => {
      (window as Window & { opened?: string }).opened = String(url);
      return null;
    };
  });
  const streetView = page.getByRole("button", {
    name: "Open in Street View",
    exact: true,
  });
  await page.mouse.click(point.x + 200, point.y - 120, { button: "right" });
  await expect(streetView).toHaveCount(0);
  await page.mouse.click(point.x, point.y, { button: "right" });
  await streetView.click();
  expect(
    await page.evaluate(() => (window as Window & { opened?: string }).opened),
  ).toContain("map_action=pano");
});

test("the base map control switches and remembers the base map", async ({
  page,
}) => {
  await page.goto("./");
  await expect(page.locator(".map")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Base map", exact: true }).click();
  await page.getByRole("radio", { name: "Hybrid", exact: true }).click();
  await expect
    .poll(() =>
      page.locator(".map").evaluate((element) => {
        const map = (element as HTMLElement & { _map: any })._map;
        return !!map.getLayer("Satellite") && !!map.getSource("route");
      }),
    )
    .toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "Base map", exact: true }).click();
  await expect(
    page.getByRole("radio", { name: "Hybrid", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
});
