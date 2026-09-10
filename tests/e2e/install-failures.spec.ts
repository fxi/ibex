import { expect, test } from "./fixtures";
test.afterEach(async ({ request }) => {
  await request.post("/__test/fault", { data: { fault: null } });
});
for (const fault of ["checksum", "disconnect"]) {
  test(`recovers from ${fault} without committing incomplete data`, async ({
    page,
    request,
  }) => {
    await request.post("/__test/fault", { data: { fault } });
    await page.goto("./");
    await page.getByRole("tab", { name: "Data", exact: true }).click();
    await page.getByRole("button", { name: /Save offline/ }).click();
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 30000 });
    if (fault === "checksum")
      await expect(page.getByRole("alert")).toContainText(
        "Pack checksum mismatch",
      );
    await expect(
      page.getByText("Region saved offline", { exact: true }),
    ).toHaveCount(0);
    await request.post("/__test/fault", {
      data: { fault: null, preserveReads: true },
    });
    await page.getByRole("tab", { name: "Data", exact: true }).click();
    await page.getByRole("button", { name: /Save offline/ }).click();
    await expect(
      page.getByText("Region saved offline", { exact: true }),
    ).toBeVisible({ timeout: 30000 });
    if (fault === "disconnect")
      expect(
        (await (await request.get("/__test/fault")).json()).graphReads,
      ).toBe(1);
  });
}
