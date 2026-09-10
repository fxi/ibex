import { describe, expect, it } from "vitest";
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
      { profile: modelSnapshot("road") },
    );
    expect(gravel.profile.bike).toBe("gravel");
    expect(road.profile.bike).toBe("road");
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
  it("preserves explicit false, zero and null in a snapshot", () => {
    const p = modelSnapshot({
      version: 1,
      name: "Custom",
      bike: "gravel",
      attraction: { quiet: 0 },
      access: { ferry: false },
      capabilities: { max_grade_up: null },
    });
    expect(p.attraction?.quiet).toBe(0);
    expect(p.access?.ferry).toBe(false);
    expect(p.capabilities?.max_grade_up).toBe(null);
  });
});
