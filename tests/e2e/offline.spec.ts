import { expect, test } from "./fixtures";
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
  await page.getByRole("tab", { name: "Data", exact: true }).click();
  await page.getByRole("button", { name: /Save offline/ }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector(".connection")
        ?.textContent?.includes("Region saved") ||
      document.querySelector('[role="alert"]'),
    {},
    { timeout: 120000 },
  );
  expect(await page.getByRole("alert").allTextContents()).toEqual([]);
  await expect(
    page.getByText("Region saved offline", { exact: true }),
  ).toBeVisible({ timeout: 120000 });
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
  await expect(
    page.getByText("Region saved offline", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Configure", exact: true }).click();
  await page.locator(".profile-editor summary").click();
  await page.getByLabel("Profile JSON", { exact: true }).fill(
    JSON.stringify({
      version: 1,
      name: "Offline explorer",
      bike: "gravel",
      attraction: {
        quiet: 80,
        climbing: 50,
        countryside: 90,
        cycling_network: 80,
      },
      access: { hike_a_bike: true, steps: true, ferry: true },
    }),
  );
  await page.getByRole("button", { name: "Save and use" }).click();
  await expect(
    page.getByText("Saved Offline explorer.", { exact: true }),
  ).toBeVisible();
  await page.locator(".profile-editor summary").click();
  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  await page.getByRole("button", { name: "Along the Arve" }).click();
  await page
    .getByRole("button", { name: "Compute active track", exact: true })
    .click();
  await page.locator(".track-details > summary").click();
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
  await page.getByText("Inside the route", { exact: false }).click();
  await expect(page.getByText(/Cost difference:/)).toBeVisible({
    timeout: 90000,
  });
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export your route" }).click();
  expect((await download).suggestedFilename()).toBe("Track-1.gpx");
  await page.getByRole("tab", { name: "Configure", exact: true }).click();
  await page
    .getByRole("button", { name: "Road", exact: false })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Compute active track", exact: true })
    .click();
  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  await page.locator(".track-details > summary").click();
  await expect(
    page.getByRole("button", { name: "Export your route" }),
  ).toBeVisible({ timeout: 90000 });
  await page.screenshot({
    path: `test-results/offline-${test.info().project.name}.png`,
  });
});
