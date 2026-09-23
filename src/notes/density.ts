import type { Span } from "./corridor";
import type { Place } from "./overpass";

/** A place, and where it sits on the route. */
export type Located = Place & { m: number; offsetM: number };

export type Density = {
  /** One place per bin of this length: the one closest to the route. */
  binM: number;
  /** Water is added back wherever the kept water points would be further apart than this. */
  waterGapM: number;
};
export const DEFAULT_DENSITY: Density = { binM: 1000, waterGapM: 10_000 };

/**
 * Thin found places to about one per `binM`, keeping in each bin the one closest to the
 * route, whatever it offers: a café 20 m off the road beats a supermarket 400 m down a side
 * street. Water is then protected, because on a long ride it is the one stop that cannot be
 * skipped: wherever the kept water points leave a gap wider than `waterGapM`, the dropped
 * water point nearest the middle of that gap comes back, and the halves are checked again.
 * The spans' ends count as edges of a gap, so a stretch that starts dry is filled too.
 */
export function thin(
  places: Located[],
  spans: Span[],
  density: Density = DEFAULT_DENSITY,
): Located[] {
  const unique = new Map<string, Located>();
  for (const p of places) {
    const seen = unique.get(p.osm);
    if (!seen || p.offsetM < seen.offsetM) unique.set(p.osm, p);
  }
  const bins = new Map<number, Located>();
  for (const p of unique.values()) {
    const bin = Math.floor(p.m / density.binM);
    const best = bins.get(bin);
    if (!best || p.offsetM < best.offsetM) bins.set(bin, p);
  }
  const kept = new Set(bins.values());
  const water = [...unique.values()]
    .filter((p) => p.kind === "water")
    .sort((a, b) => a.m - b.m);
  for (const [from, to] of spans) {
    const inside = water.filter((p) => p.m >= from && p.m <= to);
    const fill = (a: number, b: number) => {
      if (b - a <= density.waterGapM) return;
      const middle = (a + b) / 2;
      let pick: Located | undefined;
      for (const p of inside)
        if (
          p.m > a &&
          p.m < b &&
          !kept.has(p) &&
          (!pick || Math.abs(p.m - middle) < Math.abs(pick.m - middle))
        )
          pick = p;
      if (!pick) return;
      kept.add(pick);
      fill(a, pick.m);
      fill(pick.m, b);
    };
    const edges = [
      from,
      ...inside.filter((p) => kept.has(p)).map((p) => p.m),
      to,
    ];
    for (let i = 1; i < edges.length; i++) fill(edges[i - 1], edges[i]);
  }
  return [...kept].sort((a, b) => a.m - b.m);
}
