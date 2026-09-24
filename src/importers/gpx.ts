import type { Point } from "../routing/types";
import { distance } from "../geo/distance";

export type ImportedTrack = {
  name: string;
  geometry: Point[];
  /** Cumulative distance and elevation, in the shape `RouteResult` uses. */
  elevationProfile: [number, number | null][];
  distanceM: number;
  ascentM: number | null;
  descentM: number | null;
  /**
   * What an Ibex export was drawn through (`<ibex:plan>`), so the file comes back as a
   * track to edit rather than a recording. The profile is named by id only: the reader
   * may not have it.
   */
  plan?: { waypoints: Point[]; profileId?: string };
};

/** Ignore elevation noise below this, so a flat ride does not accumulate false climb. */
const ASCENT_THRESHOLD_M = 2;

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
export function decode(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => entities[name]);
}

/** Read one attribute off a start tag, tolerating either quote style and any order. */
function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(
    tag,
  );
  return match ? (match[2] ?? match[3]) : undefined;
}

/** A usable coordinate out of a start tag, or nothing. */
function coordinate(tag: string): Point | undefined {
  const lon = Number(attribute(tag, "lon"));
  const lat = Number(attribute(tag, "lat"));
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return undefined;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  return [lon, lat];
}

/** The waypoints an Ibex export keeps in `<extensions>`; fewer than two make no route. */
function readPlan(xml: string): Pick<ImportedTrack, "plan"> {
  const plan = /<ibex:plan\b([^>]*)>([\s\S]*?)<\/ibex:plan>/i.exec(xml);
  if (!plan) return {};
  const waypoints = [...plan[2].matchAll(/<ibex:waypoint\b([^>]*)>/gi)]
    .map((m) => coordinate(m[1]))
    .filter((p): p is Point => p !== undefined);
  if (waypoints.length < 2) return {};
  const profileId = attribute(plan[1], "profile");
  return {
    plan: { waypoints, ...(profileId ? { profileId: decode(profileId) } : {}) },
  };
}

/**
 * Read track and route points out of a GPX document.
 *
 * Deliberately dependency-free rather than DOM-based: this is a pure function of its
 * input, so it runs in a worker and is tested in Node like the rest of the core. It is
 * also deliberately tolerant — files come from many devices, so anything that is not a
 * usable coordinate is skipped rather than rejected. A file with no points at all is an
 * error, because silently importing nothing is worse than saying so.
 */
export function parseGPX(xml: string, fallbackName = "Imported track") {
  if (!/<gpx[\s>]/i.test(xml)) throw new Error("This file is not a GPX track.");

  // The first name inside a <trk> or <rte>, else the document metadata name.
  const named =
    /<(?:\w+:)?(?:trk|rte)\b[\s\S]*?<(?:\w+:)?name\b[^>]*>([\s\S]*?)<\/(?:\w+:)?name>/i.exec(
      xml,
    ) ??
    /<(?:\w+:)?metadata\b[\s\S]*?<(?:\w+:)?name\b[^>]*>([\s\S]*?)<\/(?:\w+:)?name>/i.exec(
      xml,
    );
  const name = decode(named?.[1] ?? "").trim() || fallbackName;

  // Collect the start tags first. A point may be self-closing or wrap children such as
  // <ele>, and the last one in a file has neither a sibling nor, when self-closing, an
  // end tag — so the body is whatever lies before the next point begins.
  const starts = [
    ...xml.matchAll(/<(?:\w+:)?(?:trkpt|rtept)\b([^>]*)>/gi),
  ];
  const geometry: Point[] = [];
  const elevations: (number | null)[] = [];
  starts.forEach((match, i) => {
    const point = coordinate(match[1]);
    if (!point) return;
    const from = match.index + match[0].length;
    const body = match[1].trimEnd().endsWith("/")
      ? ""
      : xml.slice(from, starts[i + 1]?.index ?? xml.length);
    const raw = /<(?:\w+:)?ele\b[^>]*>([\s\S]*?)<\/(?:\w+:)?ele>/i.exec(body);
    const ele = raw ? Number(decode(raw[1]).trim()) : NaN;
    geometry.push(point);
    elevations.push(Number.isFinite(ele) ? ele : null);
  });
  if (geometry.length < 2)
    throw new Error("This GPX file contains no track points.");

  const elevationProfile: [number, number | null][] = [];
  let distanceM = 0;
  let ascentM = 0;
  let descentM = 0;
  let reference: number | null = null;
  let complete = true;
  for (let i = 0; i < geometry.length; i++) {
    if (i > 0) distanceM += distance(geometry[i - 1], geometry[i]);
    const height = elevations[i];
    elevationProfile.push([distanceM, height]);
    if (height === null) {
      complete = false;
      continue;
    }
    if (reference === null) reference = height;
    const delta = height - reference;
    if (Math.abs(delta) >= ASCENT_THRESHOLD_M) {
      if (delta > 0) ascentM += delta;
      else descentM -= delta;
      reference = height;
    }
  }

  return {
    name,
    geometry,
    ...readPlan(xml),
    elevationProfile,
    distanceM,
    ascentM: complete ? Math.round(ascentM) : null,
    descentM: complete ? Math.round(descentM) : null,
  } satisfies ImportedTrack;
}
