import { z } from "zod";
import { preference, savePreference } from "./offline/store";
import { LIMITS } from "./offline/validate";
import { parseProfile, profileSchema, type Profile } from "./routing/profiles";
import { defaultProfile } from "./models";
import { download, exportGPX } from "./gpx";
import type { Point, RouteResult } from "./routing/types";
import type { Note } from "./notes/types";
import { emptyComponents } from "./routing/engine";

/**
 * A planned track is anchors the router turns into a route. An imported one is a
 * recorded polyline: it renders and exports, but it has no anchors and is never routed,
 * so what you see stays exactly the file you brought. Converting one makes a new planned
 * track beside it (`convertedTrack`).
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
  /** Extra points along the track: the rider's own, and places found beside it. */
  notes: Note[];
};
/** A collection may be empty; `activeId` is then undefined until a track is added. */
export type TrackCollection = {
  version: 1;
  activeId?: string;
  tracks: Track[];
};
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
    notes: [],
  };
}
export function editTrack(
  track: Track,
  edit: Partial<Pick<Track, "anchors" | "profile">>,
): Track {
  return { ...track, ...structuredClone(edit), revision: track.revision + 1 };
}
/**
 * What undo brings back: the fields that shape a route, and the route they had then. A
 * route is restored as it was rather than routed again, so undoing an edit whose legs were
 * cut from the previous route gives back exactly that route.
 */
export type TrackState = {
  anchors: Point[];
  profile: Profile;
  result?: RouteResult;
  routed: boolean;
};
/** Undo and redo, most recent last. Held in memory for a session, per track. */
export type TrackHistory = { undo: TrackState[]; redo: TrackState[] };
/** A long edit session stays bounded; the oldest steps are dropped first. */
export const HISTORY_LIMIT = 100;

export function trackState(track: Track): TrackState {
  return {
    anchors: track.anchors,
    profile: track.profile,
    result: track.result,
    routed: track.resultRevision === track.revision,
  };
}

/** Put `state` back as a new revision, its route still current if it was then. */
export function restoreState(track: Track, state: TrackState): Track {
  const revision = track.revision + 1;
  return {
    ...track,
    anchors: state.anchors,
    profile: state.profile,
    result: state.result,
    resultRevision: state.routed ? revision : undefined,
    revision,
  };
}

/** `track` is about to be edited: remember it, and forget what had been undone. */
export function recordEdit(history: TrackHistory, track: Track): TrackHistory {
  return {
    undo: [...history.undo, trackState(track)].slice(-HISTORY_LIMIT),
    redo: [],
  };
}

/** One step back or forward, or undefined when there is nothing that way. */
export function stepHistory(
  history: TrackHistory,
  track: Track,
  direction: "undo" | "redo",
): { history: TrackHistory; track: Track } | undefined {
  const [from, to] =
    direction === "undo"
      ? [history.undo, history.redo]
      : [history.redo, history.undo];
  const state = from.at(-1);
  if (!state) return;
  const moved = {
    from: from.slice(0, -1),
    to: [...to, trackState(track)].slice(-HISTORY_LIMIT),
  };
  return {
    history:
      direction === "undo"
        ? { undo: moved.from, redo: moved.to }
        : { undo: moved.to, redo: moved.from },
    track: restoreState(track, state),
  };
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
  const result: RouteResult = {
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
    // An imported polyline has no edges, so it has no segments either. Saying so is what
    // lets every reader trust the type instead of guarding with `?? []`.
    segments: [],
    surfaceM: {},
    uncertainM: 0,
    metrics: {
      durationMs: 0,
      explored: 0,
      expansions: 0,
      tiles: 0,
      loadedBytes: 0,
    },
  };
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
    notes: [],
  };
}

/**
 * A planned track that retraces an imported one, through `anchors` taken from its
 * recording. The import is left as it was, as the reference the new track is judged by.
 */
export function convertedTrack(
  source: Track,
  index: number,
  profile: Profile,
  anchors: Point[],
): Track {
  return {
    ...newTrack(index, profile),
    name: `${source.name} (ibex)`,
    anchors: structuredClone(anchors),
  };
}

/**
 * The track's result, but only while it still describes the track as it stands now. A
 * result outlives the edit that invalidated it so the map can keep drawing it greyed out,
 * which makes "is this current" the question every reader actually has — it was written
 * out by hand at eleven call sites, in three spellings, two of which forgot the status.
 */
export function freshResult(track: Track): RouteResult | undefined {
  return track.result &&
    track.result.status === "ok" &&
    track.resultRevision === track.revision
    ? track.result
    : undefined;
}

/** Save a track as GPX, if it has a result worth saving. */
export function exportTrack(track: Track) {
  const result = freshResult(track);
  if (result)
    download(
      `${track.name.replace(/[^a-z0-9_-]/gi, "-")}.gpx`,
      exportGPX(result, track.name, track.notes),
      "application/gpx+xml",
    );
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
/**
 * A result read back from IndexedDB, which the app then treats as a `RouteResult` the
 * router produced. Only the members the app reads are checked; unknown ones are kept
 * (`loose`), because dropping the diagnostic extras a newer build wrote would be a silent
 * downgrade rather than a validation.
 */
const storedResult = z
  .object({
    status: z.literal("ok"),
    mode: z.enum(["reference", "corridor"]),
    geometry: z.array(point).max(LIMITS.geometryPoints),
    anchors: z.array(point).max(LIMITS.anchorsMax),
    cost: z.number().finite(),
    distanceM: z.number().finite().nonnegative(),
    hikeABikeM: z.number().finite().nonnegative(),
    ferryM: z.number().finite().nonnegative(),
    ascentM: z.number().finite().nullable(),
    descentM: z.number().finite().nullable(),
    elevationProfile: z
      .array(z.tuple([z.number(), z.number().nullable()]))
      .max(LIMITS.geometryPoints),
    edgeIds: z.array(z.number().int()).max(LIMITS.chunkEdges),
    // Imported tracks were stored without this before it was part of the type; an empty
    // list is what they mean, and is cheaper than dropping the user's track.
    segments: z
      .array(
        z
          .object({
            start: z.number().int().nonnegative(),
            end: z.number().int().nonnegative(),
            surface: z.string(),
            highway: z.string(),
          })
          .loose(),
      )
      .max(LIMITS.chunkEdges)
      .default([]),
    surfaceM: z.record(z.string(), z.number()),
    uncertainM: z.number().finite().nonnegative(),
  })
  .loose()
  .transform((r) => r as unknown as RouteResult);
const storedTrack = z.object({
  id: z.string(),
  // Collections written before imports existed hold planned tracks only.
  kind: z.enum(["planned", "imported"]).default("planned"),
  name: z.string(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  visible: z.boolean(),
  anchors: z.array(point).max(LIMITS.anchorsMax),
  profile: profileSchema,
  revision: z.number().int().nonnegative(),
  resultRevision: z.number().int().optional(),
  packVersion: z.string().optional(),
  result: storedResult.optional(),
  notes: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum(["manual", "water", "food", "supermarket"]),
        point,
        text: z.string(),
        osm: z.string().optional(),
        hours: z.string().optional(),
      }),
    )
    .max(LIMITS.notesMax)
    .default([]),
});
export function restoreCollection(value: unknown): TrackCollection {
  const data = z
    .object({
      version: z.literal(1),
      activeId: z.string().optional(),
      tracks: z.array(storedTrack),
    })
    .parse(value);
  if (!data.tracks.some((t) => t.id === data.activeId))
    data.activeId = data.tracks[0]?.id;
  return data;
}
export async function loadTracks(): Promise<TrackCollection> {
  const saved = await preference<unknown>("ibex-tracks");
  if (saved !== undefined) return restoreCollection(saved);
  // A first visit starts with no track.
  const collection: TrackCollection = { version: 1, tracks: [] };
  await saveTracks(collection);
  return collection;
}
export const saveTracks = (collection: TrackCollection) =>
  savePreference("ibex-tracks", collection);
