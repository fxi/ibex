import { expect, it } from "vitest";
import { manifestSchema } from "../src/offline/store";
import manifest from "../public/packs/cell-fixture/9-264-181/manifest.json";
it("rejects traversal paths, incompatible versions and oversized allocations", () => {
  expect(manifestSchema.safeParse(manifest).success).toBe(true);
  expect(
    manifestSchema.safeParse({ ...manifest, schemaVersion: 99 }).success,
  ).toBe(false);
  // The pre-grid region pack shape must no longer parse: there is one data path.
  expect(
    manifestSchema.safeParse({ ...manifest, schemaVersion: 1 }).success,
  ).toBe(false);
  expect(
    manifestSchema.safeParse({ ...manifest, costModelVersion: 1 }).success,
  ).toBe(false);
  for (const path of ["../private", "https://other/file", "a/b"])
    expect(
      manifestSchema.safeParse({
        ...manifest,
        files: [{ ...manifest.files[0], path }, manifest.files[1]],
      }).success,
    ).toBe(false);
  expect(
    manifestSchema.safeParse({
      ...manifest,
      files: [{ ...manifest.files[0], bytes: 1e12 }, manifest.files[1]],
    }).success,
  ).toBe(false);
});
