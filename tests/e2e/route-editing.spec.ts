import type { Page } from "@playwright/test";
import { test, expect, saveMapData, planArve, ARVE } from "./fixtures";

// An edit reroutes only the legs it touched, and the status says how many it kept.
const routeReady = /^Route ready( · \d+ of \d+ legs reused)?$/;

/**
 * Points on the active route by fraction of its length, in viewport pixels. Each is moved
 * along the route until it is clear of the route handles, so the hover handle can show
 * there instead of a handle taking the pointer.
 */
function routeSpots(page: Page, fractions: number[]) {
  return page.locator(".map").evaluate(async (element, fractions) => {
    const map = (element as HTMLElement & { _map: any })._map;
    await new Promise(requestAnimationFrame);
    const geometry: number[][] = (
      await map.getSource("route").getData()
    ).features.flatMap((f: any) => f.geometry.coordinates);
    const box = map.getCanvas().getBoundingClientRect();
    const handles = [...document.querySelectorAll(".route-handle")].map((e) => {
      const r = e.getBoundingClientRect();
      return [r.x + r.width / 2, r.y + r.height / 2];
    });
    // By length along the route: fitted on a phone, a few pixels off the line can be
    // hundreds of metres from any road.
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
      return { x: q.x + box.x, y: q.y + box.y };
    };
    // Searched outwards over the whole route: fitted on a phone, the route is so short
    // that a handle can cover every spot near the one asked for. A spot only counts where
    // the map itself is under it, not the planner panel or a control.
    const canvas = map.getCanvas();
    return fractions.map((f) => {
      for (let k = 0; k < 500; k++) {
        const g = f + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.002;
        if (g < 0.02 || g > 0.98) continue;
        const q = at(g);
        if (
          document.elementFromPoint(q.x, q.y) === canvas &&
          handles.every(([x, y]) => Math.hypot(x - q.x, y - q.y) > 32)
        )
          return q;
      }
      return at(f);
    });
  }, fractions);
}

/** Geometry types in the drag preview, sorted. */
const preview = (page: Page) =>
  page.locator(".map").evaluate(async (element) => {
    const map = (element as HTMLElement & { _map: any })._map;
    const data = await map.getSource("edit-preview").getData();
    return data.features.map((f: any) => f.geometry.type).sort();
  });

async function arveRoute(page: Page) {
  await page.goto("./");
  await saveMapData(page);
  await planArve(page);
  await page
    .getByRole("button", { name: "Compute active track", exact: true })
    .click();
  await expect(page.getByText(routeReady)).toBeVisible();
}

test("route handle and include action insert intermediate waypoints", async ({
  page,
}) => {
  await arveRoute(page);
  const waypoints = page.locator(".anchor-marker-wrap");
  const count = () => waypoints.count();
  // The whole route on screen, clear of the planner panel.
  await page.locator(".map").evaluate(async (element) => {
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
  });
  const [grab, include, press] = await routeSpots(page, [0.5, 0.25, 0.8]);
  // A spot on the route a short way from the grab. Not a second spot by fraction: on a
  // phone the fitted route is so short that it can land on the grab itself, and a drag
  // that never moves is a click. Not a fixed offset either: zoomed that far out, a few
  // pixels off the route is out of reach of any road. The route is sampled every pixel or
  // so on screen, since its vertices can be far apart there.
  const drop = await page.locator(".map").evaluate(async (element, grab) => {
    const map = (element as HTMLElement & { _map: any })._map;
    const box = map.getCanvas().getBoundingClientRect();
    const line: { x: number; y: number }[] = (
      await map.getSource("route").getData()
    ).features
      .flatMap((f: any) => f.geometry.coordinates)
      .map((p: number[]) => {
        const q = map.project(p);
        return { x: q.x + box.x, y: q.y + box.y };
      });
    let best: { x: number; y: number; d: number } | undefined;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1],
        b = line[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
      for (let s = 0; s <= steps; s++) {
        const x = a.x + ((b.x - a.x) * s) / steps,
          y = a.y + ((b.y - a.y) * s) / steps;
        const d = Math.hypot(x - grab.x, y - grab.y);
        if (d >= 20 && (!best || d < best.d)) best = { x, y, d };
      }
    }
    if (!best) throw new Error("No stretch of route near the grab");
    return { x: best.x, y: best.y };
  }, grab);
  let before = await count();
  await page.mouse.move(grab.x, grab.y);
  await expect(page.locator(".route-drag-handle")).toBeVisible();
  await page.mouse.down();
  await page.mouse.move(drop.x, drop.y, { steps: 5 });
  // The dropped point, and a pinch for each dot in the preview.
  const pinches = (await preview(page)).filter(
    (t: string) => t === "Point",
  ).length;
  await page.mouse.up();
  await expect(waypoints).toHaveCount(before + 1 + pinches);
  await expect(page.getByText(routeReady)).toBeVisible();
  before = await count();
  await page.mouse.click(include.x, include.y, { button: "right" });
  await page
    .getByRole("button", { name: "Include in route", exact: true })
    .click();
  // Including is a change to the route, not a local adjustment: one waypoint and no
  // pinches, and the whole stretch between its neighbours is routed again.
  await expect(waypoints).toHaveCount(before + 1);
  await expect(page.getByText(routeReady)).toBeVisible();
  before = await count();
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
  await expect(waypoints).toHaveCount(before + 1);
});

test("a route handle branches at its neighbouring handles, and the edit can be undone", async ({
  page,
}) => {
  await arveRoute(page);
  const waypoints = page.locator(".anchor-marker-wrap");
  const before = await waypoints.count();
  // Zoomed in on the middle of the route: handles run along it, well away from its ends.
  const center = await page.locator(".map").evaluate(async (element) => {
    const map = (element as HTMLElement & { _map: any })._map;
    const geometry = (await map.getSource("route").getData()).features.flatMap(
      (f: any) => f.geometry.coordinates,
    );
    const p = geometry[Math.floor(geometry.length / 2)];
    map.jumpTo({ center: p, zoom: 15 });
    map.panBy([0, 150], { duration: 0 });
    const q = map.project(p);
    const box = map.getCanvas().getBoundingClientRect();
    return { x: q.x + box.x, y: q.y + box.y };
  });
  const handles = page.locator(".route-handle");
  await expect.poll(() => handles.count()).toBeGreaterThan(2);
  // The handle closest to the middle of the route.
  const boxes = await handles.evaluateAll((elements) =>
    elements.map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }),
  );
  const target = boxes.reduce((best, b) =>
    Math.hypot(b.x - center.x, b.y - center.y) <
    Math.hypot(best.x - center.x, best.y - center.y)
      ? b
      : best,
  );
  // Hovering shows where the edit would branch, before anything moves.
  await page.mouse.move(target.x, target.y);
  await expect(page.locator(".route-handle.is-branch")).toHaveCount(2);
  const status = page.getByText(routeReady);
  await page.mouse.down();
  await page.mouse.move(target.x + 20, target.y + 10, { steps: 5 });
  // Both branches are drawn to the pointer, with a dot on each pinch.
  await expect
    .poll(() => preview(page))
    .toEqual(["LineString", "LineString", "Point", "Point"]);
  await page.mouse.up();
  await expect.poll(() => preview(page)).toEqual([]);
  // The dropped point and a pinch on either side of it.
  await expect(waypoints).toHaveCount(before + 3);
  // Only pinch → point → pinch is routed; the two legs outside the pinches are kept.
  await expect(
    page.getByText("Route ready · 2 of 4 legs reused", { exact: true }),
  ).toBeVisible();

  // Undo puts back the waypoints and the route they had, without routing again.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(waypoints).toHaveCount(before);
  await expect(status).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Export your route" }),
  ).toBeEnabled();
  // Choosing the example was an edit too, so there is still a step before this one.
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Redo", exact: true }),
  ).toBeDisabled();
  await expect(waypoints).toHaveCount(before + 3);
  await expect(
    page.getByRole("button", { name: "Export your route" }),
  ).toBeEnabled();
});

test("right-click on the route opens the menu over the drag handle", async ({
  page,
}) => {
  await arveRoute(page);
  await page.locator(".map").evaluate(async (element) => {
    const map = (element as HTMLElement & { _map: any })._map;
    const geometry = (await map.getSource("route").getData()).features.flatMap(
      (f: any) => f.geometry.coordinates,
    );
    const p = geometry[Math.floor(geometry.length / 2)];
    map.jumpTo({ center: p, zoom: 14 });
    map.panBy([0, 150], { duration: 0 });
  });
  const [point] = await routeSpots(page, [0.5]);
  await page.mouse.move(point.x, point.y);
  await expect(page.locator(".route-drag-handle")).toBeVisible();
  await page.mouse.click(point.x, point.y, { button: "right" });
  await expect(
    page.getByRole("button", { name: "Include in route", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit in OSM", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open in Street View", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Hotels near here", exact: true }),
  ).toBeVisible();
});

test("a route not computed yet can still take a point from the menu", async ({
  page,
}) => {
  await page.goto("./");
  await saveMapData(page);
  await planArve(page);
  await expect(page.locator(".waypoint")).toHaveCount(ARVE.length);
  // Between the first two waypoints, where the straight line stands in for the route.
  const point = await page.locator(".map").evaluate(async (element, [a, b]) => {
    const map = (element as HTMLElement & { _map: any })._map;
    const middle = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    map.jumpTo({ center: middle, zoom: 13 });
    map.panBy([0, 150], { duration: 0 });
    await new Promise(requestAnimationFrame);
    const q = map.project(middle);
    const box = map.getCanvas().getBoundingClientRect();
    return { x: q.x + box.x, y: q.y + box.y };
  }, ARVE);
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page
    .getByRole("button", { name: "Include in route", exact: true })
    .click();
  await expect(page.locator(".waypoint")).toHaveCount(ARVE.length + 1);
});

test("Street View is offered anywhere on the map", async ({ page }) => {
  await page.goto("./");
  await saveMapData(page);
  await planArve(page);
  await page
    .getByRole("button", { name: "Compute active track", exact: true })
    .click();
  await expect(page.getByText(routeReady)).toBeVisible();
  // Off the Edit tab the include action is gone, so only Street View can appear.
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
  // Closing needs no tap on the map, which would drop a waypoint in the Edit tab.
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(streetView).toHaveCount(0);
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
  // The OSM editor opens at the same snapped point, zoomed in far enough to edit.
  await page.mouse.click(near.x, near.y, { button: "right" });
  await page.getByRole("button", { name: "Edit in OSM", exact: true }).click();
  const edit = await page.evaluate(
    () => (window as Window & { opened?: string }).opened ?? "",
  );
  const [zoom, ...editAt] = new URL(edit).hash
    .replace("#map=", "")
    .split("/")
    .map(Number);
  expect(edit).toMatch(/^https:\/\/www\.openstreetmap\.org\/edit#map=/);
  expect(zoom).toBe(17);
  expect(editAt).toEqual(snapped);
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
