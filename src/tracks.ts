import { z } from "zod";
import { preference, savePreference } from "./offline/store";
import {
  profileSchema,
  resolveProfile,
  type ProfileInput,
  type UserProfile,
} from "./routing/profiles";
import type { Attraction, Point, RouteResult } from "./routing/types";

export type Track = {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  anchors: Point[];
  profile: UserProfile;
  attraction?: Attraction;
  revision: number;
  resultRevision?: number;
  result?: RouteResult;
  packVersion?: string;
};
export type TrackCollection = { version: 1; activeId: string; tracks: Track[] };
const colors = ["#2485ff", "#ed42ed", "#ffb34d", "#54d5ba", "#b29aff"];
export function modelSnapshot(profile: ProfileInput): UserProfile {
  return structuredClone(resolveProfile(profile));
}
export function trackId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
export function newTrack(index = 0, profile: ProfileInput = "gravel"): Track {
  return {
    id: trackId(),
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
  edit: Partial<Pick<Track, "anchors" | "profile" | "attraction">>,
): Track {
  return { ...track, ...structuredClone(edit), revision: track.revision + 1 };
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
  name: z.string(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  visible: z.boolean(),
  anchors: z.array(point).max(12),
  profile: profileSchema,
  revision: z.number().int().nonnegative(),
  attraction: z
    .object({
      point,
      radiusM: z.number().positive(),
      strength: z.number().finite(),
    })
    .optional(),
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
  const old = await preference<{
    anchors: Point[];
    profile: ProfileInput;
    attraction?: Attraction;
  }>("plan");
  const track = newTrack();
  if (old)
    Object.assign(track, {
      anchors: z.array(point).max(12).parse(old.anchors),
      profile: modelSnapshot(old.profile),
      attraction: old.attraction,
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
