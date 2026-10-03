import { expect, test } from "./fixtures";

const boxOf = async (page: import("@playwright/test").Page) =>
  (await page.locator(".panel").boundingBox())!;

test("panel geometry is stable across tabs and survives a tap on the handle", async ({
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
    "Notes",
    "Legend",
    "Configure",
    "Tracks",
  ]) {
    await page.getByRole("tab", { name, exact: true }).click();
    const box = await boxOf(page);
    expect(Math.round(box.height)).toBe(Math.round(start.height));
    expect(Math.round(box.y)).toBe(Math.round(start.y));
  }

  // Tapping the handle reduces the panel to its tabs; it never closes, so the tabs are
  // still there to switch with and a second tap restores the chosen height.
  const handle = page.getByRole("button", { name: "Resize panel" });
  const tabs = (await page.locator(".tabs").boundingBox())!;
  const header = (await page.locator(".panel-header").boundingBox())!;
  await handle.click();
  // The header, the tabs, and nothing else: no content row is left over.
  await expect
    .poll(async () => (await boxOf(page)).height)
    .toBeLessThan(tabs.height + header.height + 4);
  await expect(
    page.getByRole("tab", { name: "Tracks", exact: true }),
  ).toBeVisible();
  await handle.click();
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
  // Held still before lifting: released while moving, the drag would be a flick and
  // open the panel fully, which is not a height that is remembered.
  await page.waitForTimeout(150);
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
            const open = indexedDB.open("ibex");
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

test("fold and expand buttons fold, open fully and restore the panel", async ({
  page,
}) => {
  await page.goto("./");
  await expect(
    page.getByRole("heading", { name: "Your tracks" }),
  ).toBeVisible();
  const start = await boxOf(page);
  const tabs = (await page.locator(".tabs").boundingBox())!;
  const header = (await page.locator(".panel-header").boundingBox())!;

  await page.getByRole("button", { name: "Fold panel" }).click();
  await expect
    .poll(async () => (await boxOf(page)).height)
    .toBeLessThan(tabs.height + header.height + 4);
  await expect(page.getByRole("button", { name: "Fold panel" })).toBeDisabled();

  await page.getByRole("button", { name: "Expand panel" }).click();
  await expect
    .poll(async () => (await boxOf(page)).height)
    .toBeGreaterThan(start.height + 40);

  // Fully open, the same button takes the panel back to the height it had.
  await page.getByRole("button", { name: "Restore panel" }).click();
  await expect
    .poll(async () => Math.round((await boxOf(page)).height))
    .toBe(Math.round(start.height));
});

test("a drag released near the bottom folds the panel", async ({ page }) => {
  await page.goto("./");
  await expect(
    page.getByRole("heading", { name: "Your tracks" }),
  ).toBeVisible();
  const start = await boxOf(page);
  const tabs = (await page.locator(".tabs").boundingBox())!;
  const header = (await page.locator(".panel-header").boundingBox())!;
  const handle = (await page.locator(".panel-handle").boundingBox())!;

  // Down to just above folded, slowly so it is not a flick: the bottom attracts.
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 4);
  await page.mouse.down();
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + start.height - tabs.height - header.height - 100,
    { steps: 20 },
  );
  await page.waitForTimeout(150);
  await page.mouse.up();
  await expect
    .poll(async () => (await boxOf(page)).height)
    .toBeLessThan(tabs.height + header.height + 4);
});
