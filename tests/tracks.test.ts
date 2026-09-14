import { describe, expect, it } from "vitest";
import { GRAVEL, ROAD } from "./helpers";
import { profileUuid, serializeProfile } from "../src/routing/profiles";
import {
  acceptResult,
  editTrack,
  modelSnapshot,
  newTrack,
  restoreCollection,
} from "../src/tracks";
import type { RouteResult } from "../src/routing/types";
describe("independent track revisions", () => {
  const result = {
    status: "ok",
    geometry: [
      [6, 46],
      [6.1, 46],
    ],
    elevationProfile: [],
  } as unknown as RouteResult;
  it("keeps model snapshots and previous results independent when duplicating and editing", () => {
    const gravel = newTrack();
    const ready = acceptResult(gravel, 0, result, "pack-1");
    const road = editTrack(
      { ...structuredClone(ready), id: "road" },
      { profile: modelSnapshot(ROAD) },
    );
    expect(gravel.profile.id).toBe(profileUuid("gravel_50"));
    expect(road.profile.id).toBe(profileUuid("road_28"));
    expect(road.resultRevision).not.toBe(road.revision);
    expect(road.result).toEqual(result);
    expect(ready.revision).toBe(ready.resultRevision);
  });
  it("rejects late and unsuccessful results without discarding the successful geometry", () => {
    const track = acceptResult(newTrack(), 0, result, "pack-1");
    const edited = editTrack(track, {
      anchors: [
        [6, 46],
        [6.2, 46],
      ],
    });
    expect(acceptResult(edited, 0, result, "pack-1")).toBe(edited);
    expect(
      acceptResult(edited, 1, { ...result, status: "no-path" }, "pack-1"),
    ).toBe(edited);
    expect(acceptResult(edited, 1, result, "pack-2").resultRevision).toBe(1);
  });
  it("restores active selection and rejects incompatible saved collections", () => {
    const track = newTrack();
    expect(
      restoreCollection({ version: 1, activeId: "missing", tracks: [track] })
        .activeId,
    ).toBe(track.id);
    expect(() =>
      restoreCollection({ version: 2, activeId: track.id, tracks: [track] }),
    ).toThrow();
  });
  it("snapshots a profile by value, so editing the model leaves the track alone", () => {
    // There is nothing to resolve any more — a profile is already complete — so the only
    // job left is the copy, and the copy has to be deep.
    const snapshot = modelSnapshot(GRAVEL);
    expect(snapshot).toEqual(GRAVEL);
    expect(snapshot).not.toBe(GRAVEL);
    expect(snapshot.setup.bike).not.toBe(GRAVEL.setup.bike);
    expect(serializeProfile(snapshot)).toBe(serializeProfile(GRAVEL));
  });

  it("refuses a collection holding a profile in the old format", () => {
    // Sparse v1 profiles meant nothing without a master file that no longer exists, so
    // they are rejected rather than guessed at.
    const track = newTrack();
    const legacy = {
      ...track,
      profile: { version: 1, name: "Old", bike: "gravel" },
    };
    expect(() =>
      restoreCollection({ version: 1, activeId: track.id, tracks: [legacy] }),
    ).toThrow();
  });
});
