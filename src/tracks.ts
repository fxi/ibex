import { z } from "zod";
import { preference, savePreference } from "./offline/store";
import { parseProfile, profileSchema, type Profile } from "./routing/profiles";
import { defaultProfile } from "./models";
import type { Point, RouteResult } from "./routing/types";
import { emptyComponents } from "./routing/engine";

/**
 * A planned track is anchors the router turns into a route. An imported one is a
 * recorded polyline: it renders and exports, but it has no anchors and is never routed,
 * so what you see stays exactly the file you brought.
 */
export type TrackKind = "planned" | "imported";
export type Track = {
  id: string;
  kind: TrackKind;
  name: string;
  color: string;
  visible: boolean;
  anchors: Point[];
  profile: Profile;
  revision: number;
  resultRevision?: number;
  result?: RouteResult;
  packVersion?: string;
};
export type TrackCollection = { version: 1; activeId: string; tracks: Track[] };
/**
 * A track's colour is its identity on the map, so the palette only has to separate one
 * track from another. Warm hues are deliberately absent: yellow through red is reserved
 * for how hard or how busy a stretch is, and a track that happened to be orange would
 * read as a warning.
 */
const colors = [
  "#2f7df6",
  "#14b86a",
  "#a855f7",
  "#00b3c7",
  "#e0399b",
  "#6b7bff",
];
/**
 * A track keeps its own copy of the profile that routed it, so editing a model later does
 * not silently change a finished track. Nothing is resolved here any more — a profile is
 * already complete — this is only the copy.
 */
export function modelSnapshot(profile: Profile): Profile {
  return parseProfile(structuredClone(profile));
}
export function trackId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
export function newTrack(
  index = 0,
  profile: Profile = defaultProfile(),
): Track {
  return {
    id: trackId(),
    kind: "planned",
    name: `Track ${index + 1}`,
    color: colors[index % colors.length],
    visible: true,
    anchors: [],
    profile: modelSnapshot(profile),
    revision: 0,
  };
}
export function editTrack(
  track: Track,
  edit: Partial<Pick<Track, "anchors" | "profile">>,
): Track {
  return { ...track, ...structuredClone(edit), revision: track.revision + 1 };
}
/**
 * Wrap an imported polyline so the rest of the app can treat it like any other track.
 * The synthetic result carries no edges and no cost, only what the file actually said.
 */
export function importedTrack(
  index: number,
  imported: {
    name: string;
    geometry: Point[];
    elevationProfile: [number, number | null][];
    distanceM: number;
    ascentM: number | null;
    descentM: number | null;
  },
): Track {
  const result = {
    status: "ok",
    mode: "reference",
    geometry: imported.geometry,
    anchors: [],
    cost: 0,
    components: emptyComponents(),
    distanceM: imported.distanceM,
    hikeABikeM: 0,
    ferryM: 0,
    ascentM: imported.ascentM,
    descentM: imported.descentM,
    elevationProfile: imported.elevationProfile,
    edgeIds: [],
    surfaceM: {},
    uncertainM: 0,
    metrics: {
      durationMs: 0,
      explored: 0,
      expansions: 0,
      tiles: 0,
      loadedBytes: 0,
    },
  } as unknown as RouteResult;
  return {
    id: trackId(),
    kind: "imported",
    name: imported.name,
    color: colors[index % colors.length],
    visible: true,
    anchors: [],
    profile: defaultProfile(),
    revision: 0,
    resultRevision: 0,
    result,
  };
}

export function acceptResult(
  track: Track,
  revision: number,
  result: RouteResult,
  packVersion: string,
): Track {
  return track.revision === revision && result.status === "ok"
    ? { ...track, result, resultRevision: revision, packVersion }
    : track;
}
const point = z.tuple([z.number().finite(), z.number().finite()]);
const storedTrack = z.object({
  id: z.string(),
  // Collections written before imports existed hold planned tracks only.
  kind: z.enum(["planned", "imported"]).default("planned"),
  name: z.string(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  visible: z.boolean(),
  anchors: z.array(point).max(12),
  profile: profileSchema,
  revision: z.number().int().nonnegative(),
  resultRevision: z.number().int().optional(),
  packVersion: z.string().optional(),
  result: z
    .custom<RouteResult>((v) => {
      const r = v as RouteResult | undefined;
      return (
        r?.status === "ok" &&
        Array.isArray(r.geometry) &&
        Array.isArray(r.elevationProfile)
      );
    })
    .optional(),
});
export function restoreCollection(value: unknown): TrackCollection {
  const data = z
    .object({
      version: z.literal(1),
      activeId: z.string(),
      tracks: z.array(storedTrack).min(1),
    })
    .parse(value);
  if (!data.tracks.some((t) => t.id === data.activeId))
    data.activeId = data.tracks[0].id;
  return data;
}
export async function loadTracks(): Promise<TrackCollection> {
  const saved = await preference<unknown>("ibex-tracks");
  if (saved !== undefined) return restoreCollection(saved);
  // Anchors from an older collection are still meaningful; its profile is not, so the
  // track restarts on the default one.
  const old = await preference<{ anchors: Point[] }>("plan");
  const track = newTrack();
  if (old?.anchors)
    Object.assign(track, {
      anchors: z.array(point).max(12).parse(old.anchors),
    });
  const collection: TrackCollection = {
    version: 1,
    activeId: track.id,
    tracks: [track],
  };
  await saveTracks(collection);
  return collection;
}
export const saveTracks = (collection: TrackCollection) =>
  savePreference("ibex-tracks", collection);
