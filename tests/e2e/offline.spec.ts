import { expect, test, saveMapData, SAVED_TEXT } from "./fixtures";
test.afterEach(async ({ request }) => {
  await request.post("http://127.0.0.1:4173/__test/network", {
    data: { offline: false },
  });
});
test("installs a region, restarts offline, compares routes and exports GPX", async ({
  page,
  context,
  browserName,
  request,
}) => {
  await page.goto("./");
  await expect(
    page.getByRole("heading", { name: "Your tracks" }),
  ).toBeVisible();
  await saveMapData(page);
  await page.waitForFunction(
    () =>
      document
        .querySelector(".connection-row")
        ?.textContent?.includes("ready for offline routing") ||
      document.querySelector('[role="alert"]'),
    {},
    { timeout: 120000 },
  );
  expect(await page.getByRole("alert").allTextContents()).toEqual([]);
  await expect(page.getByText(SAVED_TEXT, { exact: true })).toBeVisible({
    timeout: 120000,
  });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await expect(page.locator(".map")).toHaveAttribute("data-ready", "true");
  await expect(page.locator(".save-status")).toHaveText("Saved");
  const previousTimeOrigin = await page.evaluate(() => performance.timeOrigin);
  if (browserName === "webkit") {
    test.info().annotations.push({
      type: "offline-method",
      description:
        "Real server outage plus HTTP interception; setOffline breaks standalone blob workers in this WebKit build.",
    });
    await request.post("http://127.0.0.1:4173/__test/network", {
      data: { offline: true },
    });
    // The server outage blocks local transport; let the service worker handle navigation.
    await context.route("https://**", (route) => route.abort());
  } else await context.setOffline(true);
  // Exercise a page-initiated reload: WebKit's automation reload can fail with
  // service workers (microsoft/playwright#42273). The browser stays offline.
  await page.evaluate(() => {
    setTimeout(() => location.reload(), 0);
  });
  await page.waitForFunction(
    (previous) => performance.timeOrigin !== previous,
    previousTimeOrigin,
  );
  // Readiness now lives in the Data tab, so the restart has to look there for it.
  await page.getByRole("tab", { name: "Data", exact: true }).click();
  await expect(page.getByText(SAVED_TEXT, { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Configure", exact: true }).click();
  // Building a profile while offline exercises the IndexedDB write path with no network.
  await page.getByRole("button", { name: "Duplicate Gravel 40 mm" }).click();
  await page.getByLabel("Model name").fill("Offline explorer");
  await page.getByLabel("Profile id").fill("offline_explorer");
  const setLevel = (field: string, level: string) =>
    page
      .locator(".field", { has: page.getByText(field, { exact: true }) })
      .getByRole("radio", { name: level, exact: true })
      .click();
  await setLevel("Climbing", "Prefer ++");
  await setLevel("Built-up", "Avoid ++");
  await setLevel("Detour", "Prefer ++");
  await page.getByLabel("Pushing", { exact: true }).check();
  await page.getByLabel("Stairs", { exact: true }).check();
  await page.getByLabel("Ferries", { exact: true }).check();
  await page.getByRole("button", { name: "Save and use" }).click();
  await expect(
    page.getByText("Saved Offline explorer.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  await page.getByRole("button", { name: "Along the Arve" }).click();
  await page
    .getByRole("button", { name: "Compute active track", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector(".result") ||
      document.querySelector('[role="alert"]'),
    {},
    { timeout: 90000 },
  );
  expect(await page.getByRole("alert").allTextContents()).toEqual([]);
  await expect(
    page.getByRole("button", { name: "Export your route" }),
  ).toBeVisible({ timeout: 90000 });
  await page.getByRole("tab", { name: "Configure", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Show routing diagnostics on the map" })
    .check();
  await expect(page.getByText(/Cost difference:/)).toBeVisible({
    timeout: 90000,
  });
  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export your route" }).click();
  expect((await download).suggestedFilename()).toBe("Track-1.gpx");
  await page.getByRole("tab", { name: "Configure", exact: true }).click();
  await page
    .getByRole("button", { name: "Loaded touring", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Compute active track", exact: true })
    .click();
  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Export your route" }),
  ).toBeVisible({ timeout: 90000 });
  await page.screenshot({
    path: `test-results/offline-${test.info().project.name}.png`,
  });
});
