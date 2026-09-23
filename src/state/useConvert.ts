import { useState } from "react";
import { refineIndices, seedIndices } from "../routing/convert";
import type { Profile } from "../routing/profiles";
import { LIMITS } from "../offline/validate";
import { convertedTrack, editTrack } from "../tracks";
import type { TracksState } from "./useTracks";
import type { RoutingState } from "./useRouting";

/**
 * Each pass routes only the legs just split, so a few are cheap. A recording that still
 * parts after this many follows a way the map does not have, and more will not find it.
 */
const MAX_PASSES = 5;

export type ConvertState = ReturnType<typeof useConvert>;

/**
 * Turns an imported track into a planned one: routes through sparse waypoints on the
 * recording, pins a waypoint wherever the route parts from it, and routes again.
 *
 * The passes are one step as far as undo is concerned — the new track starts with the
 * waypoints the last pass left — and any edit, or choosing another track, stops them.
 */
export function useConvert({
  tracks,
  routing,
  setStatus,
}: {
  tracks: TracksState;
  routing: RoutingState;
  setStatus: (message: string) => void;
}) {
  const [converting, setConverting] = useState<string>();

  async function convert(sourceId: string, profile: Profile) {
    const current = tracks.latest.current;
    const source = current?.tracks.find((t) => t.id === sourceId);
    const recording = source?.result?.geometry;
    if (!current || !source || !recording || recording.length < 2) return;
    let indices = seedIndices(recording);
    const track = convertedTrack(
      source,
      current.tracks.length,
      profile,
      indices.map((i) => recording[i]),
    );
    tracks.insert(track);
    setConverting(sourceId);
    try {
      let deviating = 0;
      for (let pass = 1; ; pass++) {
        const route = await routing.compute();
        // Failed, and already said why, or overtaken by an edit or another track.
        if (!route) return;
        const next = refineIndices(
          recording,
          indices,
          route,
          LIMITS.anchorsMax,
        );
        deviating = next?.deviating ?? 0;
        if (!next?.changed || pass >= MAX_PASSES) break;
        const live = tracks.latest.current;
        const own = live?.tracks.find((t) => t.id === track.id);
        if (live?.activeId !== track.id || !own) return;
        indices = next.indices;
        setStatus(
          `Converting · pass ${pass + 1}, ${deviating} ${
            deviating === 1 ? "stretch" : "stretches"
          } to pin`,
        );
        tracks.updateTrack(track.id, (t) =>
          editTrack(t, { anchors: indices.map((i) => recording[i]) }),
        );
      }
      setStatus(
        deviating
          ? `Converted · ${deviating} ${
              deviating === 1 ? "stretch differs" : "stretches differ"
            } from the recording`
          : "Converted · follows the recording",
      );
    } finally {
      setConverting(undefined);
    }
  }

  return { convert, converting };
}
