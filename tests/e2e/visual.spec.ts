import { expect, test } from "@playwright/test";
test("map and planner render without application errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("./");
  await expect(page.getByRole("heading", { name: /Find your/ })).toBeVisible();
  await expect(page.locator(".map")).toHaveAttribute("data-ready", "true", {
    timeout: 30000,
  });
  await page.screenshot({
    path: `test-results/planner-${test.info().project.name}.png`,
  });
  expect(errors).toEqual([]);
});
