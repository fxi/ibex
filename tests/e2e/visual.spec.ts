import { expect, test, saveMapData, SAVED_TEXT } from "./fixtures";
test("map and planner render without application errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("./");
  await expect(
    page.getByRole("heading", { name: "Your tracks" }),
  ).toBeVisible();
  await expect(page.locator(".map")).toHaveAttribute("data-ready", "true", {
    timeout: 30000,
  });
  await page.screenshot({
    path: `test-results/planner-${test.info().project.name}.png`,
  });
  expect(errors).toEqual([]);
  await expect(page.getByTestId("map-error")).toHaveCount(0);
});

test("missing local key makes no MapTiler requests and keeps routing usable", async ({
  page,
}) => {
  // Simulate the empty build-time value, without changing the user's .env.
  await page.route("**/assets/*.js", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replaceAll(
        "cyclatractor-browser-test-key",
        "",
      ),
    });
  });
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().startsWith("https://api.maptiler.com/")) requests.push(r.url());
  });
  await page.goto("./");
  await expect(page.getByTestId("map-error")).toContainText(
    "no map access key",
  );
  await saveMapData(page);
  await expect(page.getByText(SAVED_TEXT, { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  await page.getByRole("button", { name: "Along the Arve" }).click();
  await page
    .getByRole("button", { name: "Compute active track", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Export your route" }),
  ).toBeVisible();
  expect(requests).toEqual([]);
});

test("resource failures report map status without switching style or blocking routes", async ({
  page,
}) => {
  const styles: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/style.json")) styles.push(r.url());
  });
  await page.route("https://api.maptiler.com/**", (route) => route.abort());
  await page.goto("./");
  await expect(page.getByTestId("map-error")).toContainText(
    "Map resources unavailable",
  );
  await saveMapData(page);
  await expect(page.getByText(SAVED_TEXT, { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Tracks", exact: true }).click();
  await page.getByRole("button", { name: "Along the Arve" }).click();
  await page
    .getByRole("button", { name: "Compute active track", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Export your route" }),
  ).toBeVisible();
  expect(styles).toEqual([]);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
