import { describe, expect, it } from "vitest";
import {
  PROFILE_FIELDS,
  type FieldGroup,
  type Field,
} from "../src/routing/profileFields";
import { profileSchema, resolveProfile } from "../src/routing/profiles";

/** The resolved defaults name every field the schemas accept, in every group. */
const defaults = resolveProfile("gravel");
const groups: FieldGroup[] = [
  "attraction",
  "capabilities",
  "access",
  "costs",
];

describe("profile field descriptors", () => {
  it.each(groups)("covers every %s field exactly once", (group) => {
    const schemaKeys = Object.keys(defaults[group]).sort();
    const fieldKeys = PROFILE_FIELDS[group].map((f) => f.key).sort();
    // A field with no descriptor would silently vanish from the editor; a descriptor
    // with no field would write a key the schema rejects on save.
    expect(fieldKeys).toEqual(schemaKeys);
  });

  it("uses a control that suits each value's type", () => {
    for (const group of groups)
      for (const field of PROFILE_FIELDS[group]) {
        const value = (defaults[group] as Record<string, unknown>)[field.key];
        if (typeof value === "boolean")
          expect(field.control.kind, field.key).toBe("checkbox");
        else expect(field.control.kind, field.key).not.toBe("checkbox");
      }
  });

  it("keeps every slider and radio range inside what the schema accepts", () => {
    for (const group of groups)
      for (const field of PROFILE_FIELDS[group]) {
        const bounds = extremes(field);
        if (!bounds) continue;
        for (const candidate of bounds) {
          const result = profileSchema.safeParse({
            version: 1,
            name: "Probe",
            bike: "gravel",
            [group]: { [field.key]: candidate },
          });
          expect(
            result.success,
            `${group}.${field.key} = ${candidate} must be valid`,
          ).toBe(true);
        }
      }
  });

  it("rejects values just outside a control's range, proving the bound is real", () => {
    const field = PROFILE_FIELDS.attraction[0];
    expect(field.control.kind).toBe("slider");
    const max = field.control.kind === "slider" ? field.control.max : 0;
    expect(
      profileSchema.safeParse({
        version: 1,
        name: "Probe",
        bike: "gravel",
        attraction: { [field.key]: max + 1 },
      }).success,
    ).toBe(false);
  });

  it("marks only the fields that accept an explicit no-limit", () => {
    const nullable = groups.flatMap((g) =>
      PROFILE_FIELDS[g].filter((f) => f.nullable).map((f) => f.key),
    );
    expect(nullable.sort()).toEqual(["max_grade_down", "max_grade_up"]);
    // Those two must genuinely accept null, and the others must not.
    expect(
      profileSchema.safeParse({
        version: 1,
        name: "Probe",
        bike: "gravel",
        capabilities: { max_grade_up: null },
      }).success,
    ).toBe(true);
    expect(
      profileSchema.safeParse({
        version: 1,
        name: "Probe",
        bike: "gravel",
        capabilities: { max_mtb_scale_up: null },
      }).success,
    ).toBe(false);
  });
});

/** The values worth probing: both ends of a range, and every discrete option. */
function extremes(field: Field): number[] | undefined {
  const c = field.control;
  if (c.kind === "slider") return [c.min, c.max];
  if (c.kind === "radio" || c.kind === "select")
    return c.options.map((o) => Number(o.value)).filter(Number.isFinite);
  return undefined;
}
