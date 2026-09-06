import { expect, test } from "@playwright/test";
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
    page.getByRole("heading", { name: "Find your kind of road." }),
  ).toBeVisible();
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
  const previousTimeOrigin = await page.evaluate(() => performance.timeOrigin);
  if (browserName === "webkit") {
    test
      .info()
      .annotations.push({
        type: "offline-method",
        description:
          "Real server outage plus HTTP interception; setOffline breaks standalone blob workers in this WebKit build.",
      });
    await request.post("http://127.0.0.1:4173/__test/network", {
      data: { offline: true },
    });
    await context.route(/^https?:/, (route) => route.abort());
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
  await page.getByRole("button", { name: "Along the Arve" }).click();
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
  expect((await download).suggestedFilename()).toBe("cyclatractor.gpx");
  await page
    .getByRole("button", { name: "Road", exact: false })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "Export your route" }),
  ).toBeVisible({ timeout: 90000 });
  await page.screenshot({
    path: `test-results/offline-${test.info().project.name}.png`,
  });
});
