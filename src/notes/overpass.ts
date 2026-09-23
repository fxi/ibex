/**
 * Places along a line, from the public Overpass API.
 *
 * The cells carry no places: the builder keeps water points only as a routing reward, and no
 * shops at all. Overpass is keyless, so it can be asked from the browser, and a search is
 * saved with the track so the result still reads offline. overpass-api.de refuses requests
 * without an Origin or Referer, which a browser always sends; it answers 504 or 429 when
 * busy, which is common enough that every request is retried.
 */
import { z } from "zod";
import type { Point } from "../routing/types";
import type { PlaceKind } from "./types";

export const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const ATTEMPTS = 4;
const RETRY_MS = 3000;

export type Place = {
  osm: string;
  kind: PlaceKind;
  point: Point;
  name?: string;
  hours?: string;
};

const round = (v: number) => Math.round(v * 1e5) / 1e5;

/**
 * One clause over the line rather than one per tag: `around` with a polyline is the costly
 * part, and a key/value regex lets the server run it once. What passes is sorted out here.
 */
export function overpassQuery(line: Point[], radiusM: number): string {
  const coords = line
    .map(([lon, lat]) => `${round(lat)},${round(lon)}`)
    .join(",");
  return (
    `[out:json][timeout:90];` +
    `nwr(around:${Math.round(radiusM)},${coords})` +
    `[~"^(amenity|shop|man_made)$"~"^(drinking_water|water_point|fountain|water_tap|bakery|pastry|cafe|fast_food|supermarket|convenience)$"];` +
    `out center tags;`
  );
}

/** What a set of tags offers a rider, or nothing. A fountain counts only if it is drinkable. */
export function placeKind(tags: Record<string, string>): PlaceKind | undefined {
  const { amenity, shop } = tags;
  if (tags.access === "private" || tags.access === "no") return;
  if (amenity === "drinking_water" || amenity === "water_point")
    return tags.drinking_water === "no" ? undefined : "water";
  if (
    (amenity === "fountain" || tags.man_made === "water_tap") &&
    tags.drinking_water === "yes"
  )
    return "water";
  if (shop === "bakery" || shop === "pastry") return "food";
  if (amenity === "cafe" || amenity === "fast_food") return "food";
  if (shop === "supermarket" || shop === "convenience") return "supermarket";
}

const coordinate = z.number().finite();
const response = z.object({
  remark: z.string().optional(),
  elements: z.array(
    z.object({
      type: z.enum(["node", "way", "relation"]),
      id: z.number().int(),
      lat: coordinate.optional(),
      lon: coordinate.optional(),
      center: z.object({ lat: coordinate, lon: coordinate }).optional(),
      tags: z.record(z.string(), z.string()).default({}),
    }),
  ),
});

/** The places in an Overpass JSON answer. Throws when it is not one, or is cut short. */
export function parsePlaces(json: unknown): Place[] {
  const data = response.parse(json);
  // A timeout or memory error still answers 200, with whatever was found so far.
  if (data.remark && /error/i.test(data.remark))
    throw new Error(`Overpass: ${data.remark}`);
  const places: Place[] = [];
  for (const e of data.elements) {
    const lat = e.lat ?? e.center?.lat,
      lon = e.lon ?? e.center?.lon;
    const kind = placeKind(e.tags);
    if (lat === undefined || lon === undefined || !kind) continue;
    places.push({
      osm: `${e.type}/${e.id}`,
      kind,
      point: [lon, lat],
      name: e.tags.name ?? e.tags.brand,
      hours: e.tags.opening_hours,
    });
  }
  return places;
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

/**
 * The places within `radiusM` of a line, retrying across endpoints while servers are busy.
 * `first` picks the endpoint to try first, so parallel queries spread over the servers.
 */
export async function fetchPlaces(
  line: Point[],
  radiusM: number,
  signal?: AbortSignal,
  first = 0,
): Promise<Place[]> {
  const body = new URLSearchParams({ data: overpassQuery(line, radiusM) });
  let failure: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt) await wait(RETRY_MS * attempt, signal);
    const url =
      OVERPASS_ENDPOINTS[(first + attempt) % OVERPASS_ENDPOINTS.length];
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", body, signal });
      if (res.ok) return parsePlaces(await res.json());
    } catch (e) {
      if (signal?.aborted) throw e;
      failure = e;
      continue;
    }
    failure = new Error(`Overpass answered ${res.status}`);
    // Anything but "busy" will not get better by asking again.
    if (res.status !== 429 && res.status < 500) break;
  }
  throw failure;
}
