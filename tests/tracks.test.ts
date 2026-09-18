import { describe, expect, it } from "vitest";
import { GRAVEL, ROAD } from "./helpers";
import { DEFAULT_PROFILE_ID } from "../src/models";
import { serializeProfile } from "../src/routing/profiles";
import {
  HISTORY_LIMIT,
  acceptResult,
  editTrack,
  exploreLegs,
  modelSnapshot,
  newTrack,
  recordEdit,
  restoreCollection,
  stepHistory,
  type TrackHistory,
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
    expect(gravel.profile.id).toBe(DEFAULT_PROFILE_ID);
    expect(road.profile.id).toBe(ROAD.id);
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
  it("restores an empty collection with no active track", () => {
    const empty = restoreCollection({ version: 1, tracks: [] });
    expect(empty.tracks).toEqual([]);
    expect(empty.activeId).toBeUndefined();
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

  it("undoes and redoes edits with the route each step had", () => {
    const empty: TrackHistory = { undo: [], redo: [] };
    const a: [number, number][] = [
      [6, 46],
      [6.1, 46],
    ];
    const b: [number, number][] = [...a, [6.2, 46]];
    const other = { ...result, geometry: b } as RouteResult;
    const first = acceptResult(
      editTrack(newTrack(), { anchors: a }),
      1,
      result,
      "p",
    );
    let history = recordEdit(empty, first);
    // Edited, then routed later: the route that arrives belongs to the redo step.
    const second = acceptResult(
      editTrack(first, { anchors: b }),
      2,
      other,
      "p",
    );

    const back = stepHistory(history, second, "undo")!;
    expect(back.track.anchors).toEqual(a);
    expect(back.track.result).toBe(result);
    expect(back.track.resultRevision).toBe(back.track.revision);
    expect(back.track.revision).toBeGreaterThan(second.revision);
    expect(stepHistory(back.history, back.track, "undo")).toBeUndefined();

    const forward = stepHistory(back.history, back.track, "redo")!;
    expect(forward.track.anchors).toEqual(b);
    expect(forward.track.result).toBe(other);
    expect(forward.track.resultRevision).toBe(forward.track.revision);

    // A new edit after an undo drops what could have been redone.
    history = recordEdit(back.history, back.track);
    expect(history.redo).toEqual([]);
    expect(history.undo).toHaveLength(1);

    // A step that was never routed comes back needing computation.
    const unrouted = stepHistory(
      recordEdit(empty, editTrack(first, { anchors: b })),
      first,
      "undo",
    )!;
    expect(unrouted.track.resultRevision).not.toBe(unrouted.track.revision);

    let long = empty;
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) long = recordEdit(long, first);
    expect(long.undo).toHaveLength(HISTORY_LIMIT);
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

describe("exploring legs", () => {
  const a: [number, number] = [6, 46],
    b: [number, number] = [6.1, 46],
    c: [number, number] = [6.2, 46],
    d: [number, number] = [6.3, 46];
  const planned = editTrack(newTrack(), { anchors: [a, b, c] });

  it("explores every leg of a new track", () => {
    expect(planned.explore).toBe(true);
    expect(exploreLegs(planned)).toEqual([true, true]);
  });

  it("routes the legs at a hand-placed waypoint as drawn", () => {
    const inserted = editTrack(planned, { anchors: [a, d, b, c], pin: [d] });
    expect(exploreLegs(inserted)).toEqual([false, false, true]);
  });

  it("keeps a pin with its waypoint and drops it with it", () => {
    const pinned = editTrack(planned, { pin: [b] });
    const reordered = editTrack(pinned, { anchors: [b, a, c] });
    expect(exploreLegs(reordered)).toEqual([false, true]);
    expect(editTrack(pinned, { anchors: [a, c] }).pinned).toEqual([]);
  });

  it("explores nothing when the track does not", () => {
    expect(exploreLegs(editTrack(planned, { explore: false }))).toEqual([
      false,
      false,
    ]);
  });

  it("restores tracks saved before exploration was a choice", () => {
    const { pinned: _, explore: __, ...old } = planned;
    const restored = restoreCollection({
      version: 1,
      activeId: planned.id,
      tracks: [old],
    }).tracks[0];
    expect(restored.explore).toBe(true);
    expect(restored.pinned).toEqual([]);
  });
});
