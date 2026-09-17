import { networkInterfaces } from "node:os";
import { expect, test, saveMapData, planArve, SAVED_TEXT } from "./fixtures";
const address = Object.values(networkInterfaces())
  .flat()
  .find((n) => n?.family === "IPv4" && !n.internal)?.address;
test("installs and routes on insecure LAN HTTP without StorageManager or Web Crypto", async ({
  page,
}) => {
  test.skip(!address, "No LAN interface available");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://${address}:4173/ibex/`);
  expect(await page.evaluate(() => isSecureContext)).toBe(false);
  expect(await page.evaluate(() => typeof navigator.storage)).toBe("undefined");
  await saveMapData(page);
  await expect(page.getByText(SAVED_TEXT, { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await planArve(page);
  await page
    .getByRole("button", { name: "Compute active track", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Export your route" }),
  ).toBeVisible({ timeout: 30000 });
  expect(errors).toEqual([]);
});
