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

test("Street View is offered anywhere on the map", async ({ page }) => {
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
  const opened = async () => {
    const url = await page.evaluate(
      () => (window as Window & { opened?: string }).opened ?? "",
    );
    expect(url).toContain("map_action=pano");
    return new URL(url).searchParams.get("viewpoint")!.split(",").map(Number);
  };
  // Away from the route and from any drawn road (test tiles are empty), the click itself
  // is the viewpoint. A phone leaves little bare map between the buttons and the panel,
  // so the spot is searched for rather than hard-coded.
  const away = await page.locator(".map").evaluate((element, p) => {
    const map = (element as HTMLElement & { _map: any })._map;
    const canvas = map.getCanvas();
    for (let dy = -40; dy >= -200; dy -= 20)
      for (const dx of [-120, -80, 80, 120]) {
        const x = Math.round(p.x + dx),
          y = Math.round(p.y + dy);
        if (document.elementFromPoint(x, y) !== canvas) continue;
        const near = map.queryRenderedFeatures(
          [
            [x - 40, y - 40],
            [x + 40, y + 40],
          ],
          { layers: ["route"] },
        );
        if (!near.length) return { x, y };
      }
    throw new Error("No bare map in view");
  }, point);
  await page.mouse.click(away.x, away.y, { button: "right" });
  await streetView.click();
  const expected = await page.locator(".map").evaluate((element, p) => {
    const q = (element as HTMLElement & { _map: any })._map.unproject([
      p.x,
      p.y,
    ]);
    return [q.lat, q.lng];
  }, away);
  const [lat, lng] = await opened();
  expect(lat).toBeCloseTo(expected[0], 4);
  expect(lng).toBeCloseTo(expected[1], 4);
  // Near the route, the viewpoint moves off the click and onto the route.
  const near = { x: point.x + 10, y: point.y + 10 };
  await page.mouse.click(near.x, near.y, { button: "right" });
  await streetView.click();
  const snapped = await opened();
  const landing = await page.locator(".map").evaluate(
    (element, { at: [la, ln], click }) => {
      const map = (element as HTMLElement & { _map: any })._map;
      const q = map.project([ln, la]);
      return {
        moved: Math.hypot(q.x - click.x, q.y - click.y),
        onRoute: map.queryRenderedFeatures([q.x, q.y], { layers: ["route"] })
          .length,
      };
    },
    { at: snapped, click: near },
  );
  expect(landing.moved).toBeGreaterThan(2);
  expect(landing.onRoute).toBeGreaterThan(0);
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
