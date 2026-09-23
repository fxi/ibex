import { inSpans, routeChunks, type Span } from "./corridor";
import { thin, type Located } from "./density";
import { fetchPlaces } from "./overpass";
import type { RouteIndex } from "./routeIndex";
import type { Note } from "./types";

/**
 * Measured on 2026-09-23: a busy server takes 10–30 s per query whatever its length, so the
 * chunks are long and few. A 500 km ride is thirteen queries.
 */
const CHUNK_M = 40_000;
/**
 * Queries in flight at once. overpass-api.de grants each client four slots; two leave room
 * for the retries, and each starts on a different server.
 */
const PARALLEL = 2;

/**
 * Find the places beside the route along `spans`, one query per chunk. A chunk the servers
 * never answer is left out of `covered` rather than failing the whole ride: on a long route
 * one bad query should not throw away the other twelve. Only when none answers does it throw.
 */
export async function findPlaces(options: {
  index: RouteIndex;
  spans: Span[];
  bufferM: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ places: Located[]; covered: Span[]; failed: number }> {
  const { index, spans, bufferM, signal, onProgress } = options;
  // The query follows a simplified line, so it reaches a little wider and the exact distance
  // to the real route decides.
  const toleranceM = bufferM / 5;
  const chunks = routeChunks(index, spans, CHUNK_M, toleranceM);
  const found: Located[] = [];
  const covered: Span[] = [];
  let next = 0,
    done = 0,
    failure: unknown;
  onProgress?.(0, chunks.length);
  const worker = async (lane: number) => {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      let places;
      try {
        places = await fetchPlaces(
          chunk.line,
          bufferM + toleranceM,
          signal,
          lane,
        );
      } catch (e) {
        if (signal?.aborted) throw e;
        failure = e;
        onProgress?.(++done, chunks.length);
        continue;
      }
      covered.push([chunk.fromM, chunk.toM]);
      for (const place of places) {
        const at = index.locate(place.point, bufferM);
        if (at && at.m >= chunk.fromM && at.m <= chunk.toM)
          found.push({ ...place, m: at.m, offsetM: at.offsetM });
      }
      onProgress?.(++done, chunks.length);
    }
  };
  await Promise.all(
    Array.from({ length: PARALLEL }, (_, lane) => worker(lane)),
  );
  if (!covered.length) throw failure;
  covered.sort((a, b) => a[0] - b[0]);
  return {
    places: thin(found, covered),
    covered,
    failed: chunks.length - covered.length,
  };
}

/**
 * A search replaces the places it covered and nothing else: the rider's own notes stay, and
 * so do places found earlier elsewhere on the route, or no longer beside it.
 */
export function mergePlaces(
  notes: Note[],
  found: Located[],
  index: RouteIndex,
  spans: Span[],
  bufferM: number,
): Note[] {
  const kept = notes.filter((n) => {
    if (n.kind === "manual") return true;
    const at = index.locate(n.point, bufferM);
    return !at || !inSpans(spans, at.m);
  });
  const present = new Set(kept.map((n) => n.osm).filter(Boolean));
  return [
    ...kept,
    ...found
      .filter((p) => !present.has(p.osm))
      .map((p): Note => ({
        id: p.osm,
        kind: p.kind,
        point: p.point,
        text: p.name ?? "",
        osm: p.osm,
        ...(p.hours ? { hours: p.hours } : {}),
      })),
  ];
}
