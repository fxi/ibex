import { expect, it } from "vitest";
import { manifestSchema } from "../src/offline/store";
import { catalogueSchema, toManifest } from "../src/offline/catalogue";
import catalog from "./fixtures/data/catalog.json";

const parsed = catalogueSchema.parse(catalog);
const manifest = toManifest(parsed, parsed.cells[0]);
it("rejects traversal paths, incompatible versions and oversized allocations", () => {
  expect(manifestSchema.safeParse(manifest).success).toBe(true);
  // Cells from any other data version must not parse: this build cannot read them.
  expect(
    manifestSchema.safeParse({ ...manifest, dataVersion: 99 }).success,
  ).toBe(false);
  const { dataVersion, ...unversioned } = manifest;
  expect(dataVersion).toBe(1);
  expect(manifestSchema.safeParse(unversioned).success).toBe(false);
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
