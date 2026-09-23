import { expect, test, saveMapData, planArve, SAVED_TEXT } from "./fixtures";
// Without a map, planArve reloads; a service worker would then serve the cached bundle
// and bypass the routes that fail the map resources.
test.use({ serviceWorkers: "block" });
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

test("resource failures report map status without switching style or blocking routes", async ({
  page,
}) => {
  await page.route("**/data/map.json", (route) => route.abort());
  await page.route("https://tiles.mapterhorn.com/**", (route) => route.abort());
  await page.goto("./");
  await expect(page.getByTestId("map-error")).toContainText(
    "Map resources unavailable",
  );
  await saveMapData(page);
  await expect(page.getByText(SAVED_TEXT, { exact: true })).toBeVisible();
  await planArve(page);
  await page
    .getByRole("button", { name: "Compute active track", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Export your route" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
