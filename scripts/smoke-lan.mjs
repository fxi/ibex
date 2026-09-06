import { chromium } from "@playwright/test";
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.argv[2] || "http://192.168.1.104:5173/cyclatractor/");
  await page.getByRole("button", { name: /Save locally.*MB/ }).waitFor();
  await page.getByRole("button", { name: /Save locally/ }).click();
  await page
    .getByText("Region saved locally", { exact: true })
    .waitFor({ timeout: 120000 });
  await page.getByRole("button", { name: "Along the Arve" }).click();
  await page
    .getByRole("button", { name: "Export your route" })
    .waitFor({ timeout: 120000 });
  console.log(
    JSON.stringify({
      secureContext: await page.evaluate(() => isSecureContext),
      errors,
      routed: true,
    }),
  );
  if (errors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
