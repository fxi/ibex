import { expect, test } from "./fixtures";

const boxOf = async (page: import("@playwright/test").Page) =>
  (await page.locator(".panel").boundingBox())!;

test("panel geometry is stable across tabs and survives collapsing", async ({
  page,
}) => {
  await page.goto("./");
  await expect(
    page.getByRole("heading", { name: "Your tracks" }),
  ).toBeVisible();
  const start = await boxOf(page);

  // The whole point of the explicit height: content no longer moves the panel.
  for (const name of [
    "Edit",
    "Data",
    "Tools",
    "Legend",
    "Configure",
    "Tracks",
  ]) {
    await page.getByRole("tab", { name, exact: true }).click();
    const box = await boxOf(page);
    expect(Math.round(box.height)).toBe(Math.round(start.height));
    expect(Math.round(box.y)).toBe(Math.round(start.y));
  }

  await page.getByRole("button", { name: "Collapse panel" }).click();
  await expect.poll(async () => (await boxOf(page)).height).toBeLessThan(
    start.height,
  );
  await page.getByRole("button", { name: "Open panel" }).click();
  await expect
    .poll(async () => Math.round((await boxOf(page)).height))
    .toBe(Math.round(start.height));
});

test("dragging the handle resizes the panel and the size is remembered", async ({
  page,
}) => {
  await page.goto("./");
  await expect(
    page.getByRole("heading", { name: "Your tracks" }),
  ).toBeVisible();
  const start = await boxOf(page);
  const handle = (await page.locator(".panel-handle").boundingBox())!;

  // Drag upward: the panel is bottom-anchored, so it grows.
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 4);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y - 120, {
    steps: 10,
  });
  await page.mouse.up();

  await expect
    .poll(async () => (await boxOf(page)).height)
    .toBeGreaterThan(start.height + 60);

  // The height is written to IndexedDB after the drag settles; wait for it to land
  // rather than racing the reload against an async write.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<number | undefined>((resolve) => {
            const open = indexedDB.open("cyclatractor-v1");
            open.onerror = () => resolve(undefined);
            open.onsuccess = () => {
              const get = open.result
                .transaction("preferences")
                .objectStore("preferences")
                .get("panel-height");
              get.onsuccess = () => resolve(get.result as number | undefined);
              get.onerror = () => resolve(undefined);
            };
          }),
      ),
    )
    .toBeGreaterThan(0);

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your tracks" }),
  ).toBeVisible();
  await expect
    .poll(async () => (await boxOf(page)).height, { timeout: 15000 })
    .toBeGreaterThan(start.height + 60);
});
