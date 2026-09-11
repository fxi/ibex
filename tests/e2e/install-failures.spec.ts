import { expect, test, saveMapData, SAVED_TEXT } from "./fixtures";
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
    await saveMapData(page);
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 30000 });
    if (fault === "checksum")
      await expect(page.getByRole("alert")).toContainText(
        "Pack checksum mismatch",
      );
    await expect(page.getByText(SAVED_TEXT, { exact: true })).toHaveCount(0);
    await request.post("/__test/fault", {
      data: { fault: null, preserveReads: true },
    });
    await saveMapData(page);
    await expect(page.getByText(SAVED_TEXT, { exact: true })).toBeVisible({
      timeout: 30000,
    });
    if (fault === "disconnect")
      expect(
        (await (await request.get("/__test/fault")).json()).graphReads,
      ).toBe(1);
  });
}
