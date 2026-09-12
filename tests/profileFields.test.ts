import { describe, expect, it } from "vitest";
import {
  BIKE_FIELDS,
  PERMISSION_FIELDS,
  PREFERENCE_FIELDS,
  RIDER_FIELDS,
  SUSPENSION_OPTIONS,
} from "../src/routing/profileFields";
import {
  bikeSchema,
  parseProfile,
  permissionsSchema,
  riderSchema,
} from "../src/routing/profiles";
import { BIKE_PRESETS, RIDER_PRESETS } from "../src/routing/presets";
import { PREFERENCE_KEYS } from "../src/routing/vocabulary";
import { GRAVEL } from "./helpers";

/**
 * The form and the schema have to describe the same profile.
 *
 * There is no inheritance to fall back on any more: a field with no control is a value a
 * rider can never see or change, and a control with no field silently does nothing. Both
 * should fail here rather than in front of someone trying to set up a bike.
 */
describe("profile form descriptors", () => {
  it("covers every bike and rider field exactly once", () => {
    expect(BIKE_FIELDS.map((f) => f.key).sort()).toEqual(
      Object.keys(bikeSchema.shape)
        .filter((k) => k !== "suspension")
        .sort(),
    );
    expect(RIDER_FIELDS.map((f) => f.key).sort()).toEqual(
      Object.keys(riderSchema.shape).sort(),
    );
    // `suspension` is the one non-numeric setup field, so it gets its own control.
    expect(SUSPENSION_OPTIONS.map((o) => o.value).sort()).toEqual([
      "front",
      "full",
      "none",
    ]);
  });

  it("covers every preference and permission exactly once", () => {
    expect(PREFERENCE_FIELDS.map((f) => f.key)).toEqual([...PREFERENCE_KEYS]);
    expect(PERMISSION_FIELDS.map((f) => f.key).sort()).toEqual(
      Object.keys(permissionsSchema.shape).sort(),
    );
  });

  it("gives every control a label and a hint", () => {
    for (const f of [
      ...BIKE_FIELDS,
      ...RIDER_FIELDS,
      ...PREFERENCE_FIELDS,
      ...PERMISSION_FIELDS,
    ]) {
      expect(f.label.length, f.key).toBeGreaterThan(0);
      expect(f.hint.length, f.key).toBeGreaterThan(10);
    }
  });

  it("keeps slider extremes inside the schema", () => {
    for (const f of BIKE_FIELDS)
      for (const value of [f.min, f.max])
        expect(() =>
          parseProfile({
            ...GRAVEL,
            setup: {
              ...GRAVEL.setup,
              bike: { ...GRAVEL.setup.bike, [f.key]: value },
            },
          }),
        ).not.toThrow();
    for (const f of RIDER_FIELDS)
      for (const value of [f.min, f.max])
        expect(() =>
          parseProfile({
            ...GRAVEL,
            setup: {
              ...GRAVEL.setup,
              rider: { ...GRAVEL.setup.rider, [f.key]: value },
            },
          }),
        ).not.toThrow();
  });

  it("ships presets that are themselves valid setups", () => {
    for (const [id, bike] of Object.entries(BIKE_PRESETS))
      expect(() => bikeSchema.parse(bike), id).not.toThrow();
    for (const [id, rider] of Object.entries(RIDER_PRESETS))
      expect(() => riderSchema.parse(rider), id).not.toThrow();
  });
});
