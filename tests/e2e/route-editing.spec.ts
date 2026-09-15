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
  // The whole route on screen, clear of the planner panel: every waypoint is in view, so
  // no edit here needs pinching and each one only splits or moves as it always did.
  const spots = await page.locator(".map").evaluate(async (element) => {
    const map = (element as HTMLElement & { _map: any })._map;
    const geometry = (await map.getSource("route").getData()).features.flatMap(
      (f: any) => f.geometry.coordinates,
    );
    const panel = document
      .querySelector('[aria-label="Route planner"]')!
      .getBoundingClientRect();
    const [w, s, e, n] = geometry.reduce(
      (b: number[], [x, y]: number[]) => [
        Math.min(b[0], x),
        Math.min(b[1], y),
        Math.max(b[2], x),
        Math.max(b[3], y),
      ],
      [Infinity, Infinity, -Infinity, -Infinity],
    );
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      {
        padding: { top: 90, bottom: panel.height + 150, left: 70, right: 70 },
        duration: 0,
      },
    );
    // Spots on the route itself, by length along it: fitted on a phone, a few pixels off
    // the line can be hundreds of metres from any road.
    const along = [0];
    for (let i = 1; i < geometry.length; i++)
      along.push(
        along[i - 1] +
          Math.hypot(
            geometry[i][0] - geometry[i - 1][0],
            geometry[i][1] - geometry[i - 1][1],
          ),
      );
    const at = (f: number) => {
      const target = along.at(-1)! * f;
      const i = Math.max(
        1,
        along.findIndex((d) => d >= target),
      );
      const t = (target - along[i - 1]) / (along[i] - along[i - 1] || 1);
      const q = map.project([
        geometry[i - 1][0] + t * (geometry[i][0] - geometry[i - 1][0]),
        geometry[i - 1][1] + t * (geometry[i][1] - geometry[i - 1][1]),
      ]);
      return { x: q.x, y: q.y };
    };
    return {
      grab: at(0.5),
      drop: at(0.6),
      include: at(0.25),
      press: at(0.8),
    };
  });
  const { grab, drop, include, press } = spots;
  await page.mouse.move(grab.x, grab.y);
  await expect(page.locator(".route-drag-handle")).toBeVisible();
  await page.mouse.down();
  await page.mouse.move(drop.x, drop.y, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(".anchor-marker-wrap")).toHaveCount(before + 1);
  await expect(page.getByText(routeReady)).toBeVisible();
  await page.mouse.click(include.x, include.y, { button: "right" });
  await page
    .getByRole("button", { name: "Include in route", exact: true })
    .click();
  await expect(page.locator(".anchor-marker-wrap")).toHaveCount(before + 2);
  // Including a point splits one of the two legs; the other is reused, not rerouted.
  await expect(
    page.getByText("Route ready · 1 of 3 legs reused", { exact: true }),
  ).toBeVisible();
  const canvas = page.locator(".map canvas");
  const touch = { identifier: 0, clientX: press.x, clientY: press.y };
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

test("a zoomed-in edit pins the route at the screen edge and keeps the rest", async ({
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
  // Zoomed in on the middle of the route, neither of its ends is on screen.
  const point = await page.locator(".map").evaluate(async (element) => {
    const map = (element as HTMLElement & { _map: any })._map;
    const geometry = (await map.getSource("route").getData()).features.flatMap(
      (f: any) => f.geometry.coordinates,
    );
    const p = geometry[Math.floor(geometry.length / 2)];
    map.jumpTo({ center: p, zoom: 15 });
    map.panBy([0, 150], { duration: 0 });
    const q = map.project(p);
    return { x: q.x, y: q.y };
  });
  const preview = () =>
    page.locator(".map").evaluate(async (element) => {
      const map = (element as HTMLElement & { _map: any })._map;
      const data = await map.getSource("edit-preview").getData();
      return data.features.map((f: any) => f.geometry.type).sort();
    });
  await page.mouse.move(point.x, point.y);
  await expect(page.locator(".route-drag-handle")).toBeVisible();
  await page.mouse.down();
  await page.mouse.move(point.x + 20, point.y + 10, { steps: 5 });
  // A dashed line from each pinch to the pointer, and a dot on each pinch.
  await expect
    .poll(preview)
    .toEqual(["LineString", "LineString", "Point", "Point"]);
  await page.mouse.up();
  await expect.poll(preview).toEqual([]);
  // The dropped point and a pinch on either side of it.
  await expect(page.locator(".anchor-marker-wrap")).toHaveCount(before + 3);
  // Only pinch → point → pinch is routed; the two legs outside the pinches are kept.
  await expect(
    page.getByText("Route ready · 2 of 4 legs reused", { exact: true }),
  ).toBeVisible();
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
