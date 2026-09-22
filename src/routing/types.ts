import type { Profile } from "./profiles";
import type { CompiledProfile } from "./compile";
import type { RideClass } from "./eligibility";
export type { RideClass };
export const COST_MODEL_VERSION = 6;
export type Point = [number, number];
export type Node = { id: number; p: Point; elevation: number | null };
export type Edge = {
  /** Packager-derived facts, independent of rider policy. Older packs derive these locally. */
  semantics?: import("./signals").Signals & { version: 1 };
  id: number;
  from: number;
  to: number;
  way: string;
  length: number;
  geometry: Point[];
  grades: [number, number][] | null;
  surface: string;
  highway: string;
  tags?: Record<string, string>;
  stress: number;
  uncertainty: number;
  utility: number;
  urban?: number;
  cyclingNetwork?: number;
  ferryService?: string;
  ferrySeconds?: number;
  quality?: number;
  forest?: number;
  reward?: number;
  junction?: number;
  bridge: boolean;
  tunnel: boolean;
  name: string;
  tile: string;
};
export type Restriction = {
  ways: string[];
  via?: number;
  only: boolean;
  uTurn?: boolean;
};
export type Graph = {
  schemaVersion: 1;
  bbox: [number, number, number, number];
  nodes: Node[];
  edges: Edge[];
  restrictions: Restriction[];
};
export type Attraction = { point: Point; radiusM: number; strength: number };
export type RouteRequest = {
  anchors: Point[];
  profile: Profile | CompiledProfile;
  attraction?: Attraction;
  maxSettled?: number;
  /** Expensive corridor/reference/scenic comparisons, only for explicit audits. */
  diagnostics?: boolean;
  /** Dijkstra remains available as a correctness oracle for the accelerated query. */
  search?: "astar" | "dijkstra";
};
/**
 * A cost, broken down so a route can be explained.
 *
 * Every term is in equivalent metres except `distanceM`, which is the real ridden
 * distance and is deliberately not part of `total`. `base` is what that distance would
 * cost on an ordinary road and `preference` is what the rider's tastes did to it —
 * negative on a way they like, which is what lets a detour win.
 */
export type Components = {
  /** Real distance in metres. A report, not a cost. */
  distanceM: number;
  /** The reference: ridden length at rate 1. */
  base: number;
  /** What the preferences bought or cost, against that reference. */
  preference: number;
  /** Past what this rider on this bike is comfortable with. Never blocking. */
  slope: number;
  technical: number;
  roughness: number;
  /** Traffic above ordinary, for a rider who avoids it. A hazard, so outside the budget. */
  traffic: number;
  /** Not a matter of taste: unsurveyed ground, and severed or dead-end fragments. */
  uncertainty: number;
  network: number;
  /** Priced per event rather than per metre. */
  junction: number;
  /** Pushing and carrying. */
  walking: number;
  ferry: number;
  /** A pull towards a point the rider dropped on the map. */
  attraction: number;
  /** What the rate ceiling removed, so the parts still sum to the whole. */
  clamp: number;
};
/**
 * One stretch of the finished route that is uniform in how it rides. Indices address
 * `RouteResult.geometry`, so a segment can be drawn without re-deriving anything.
 */
export type RouteSegment = {
  /** First vertex, indexing `RouteResult.geometry`. */
  start: number;
  /**
   * Last vertex, inclusive — so the polyline is `geometry.slice(start, end + 1)` and
   * `end - start` is the number of spans. Consecutive segments share a vertex.
   */
  end: number;
  ride: RideClass;
  surface: string;
  highway: string;
  /** OSM `sac_scale`, when the way carries one. */
  sac?: string;
  /**
   * Fractional grade of this segment's *first* grade run, positive uphill, or null where
   * elevation is unknown. Deliberately not length-weighted, which would hide a short steep
   * ramp inside a long segment; read `RouteResult.elevationProfile` for the grade at a
   * given distance.
   */
  grade: number | null;
  /** Traffic stress as ridden, 0..1, calmed where a cycle route is signed. */
  stress: number;
  /**
   * The router's own roughness, 0..1 — the worst of `surface`, `smoothness` and
   * `tracktype`, not a second opinion derived from `surface` alone. It is here because
   * the elevation chart has to know what the ground was to paint the same steep lane the
   * router priced; see `tractionGrade`.
   */
  roughness: number;
  lengthM: number;
};
export type RouteStatus =
  | "ok"
  /** Outside the published grid entirely. */
  | "outside-coverage"
  /** Published, but the areas the route needs are not installed. */
  | "missing-cells"
  | "snap-failed"
  | "no-path"
  | "budget-exceeded";
export type RouteResult = {
  status: RouteStatus;
  /** One-based index of an ordered waypoint leg known to be disconnected. */
  failedLeg?: number;
  /** Cell ids the search needed but could not read, for "missing-cells". */
  missingCells?: string[];
  mode: "reference" | "corridor";
  geometry: Point[];
  anchors: Point[];
  cost: number;
  components: Components;
  distanceM: number;
  hikeABikeM: number;
  ferryM: number;
  ascentM: number | null;
  descentM: number | null;
  elevationProfile: [number, number | null][];
  edgeIds: number[];
  segments: RouteSegment[];
  surfaceM: Record<string, number>;
  uncertainM: number;
  metrics: {
    durationMs: number;
    loadMs?: number;
    explored: number;
    /** Relaxed node states used to prepare the search lower bound. */
    preparedStates?: number;
    /**
     * How strong the A* lower bound was, in [0, 1]. One odd edge — a length short against
     * its endpoint chord — drops this towards 0 and degrades the search towards Dijkstra.
     * It cannot be clamped without breaking admissibility, so it is reported instead: a
     * route that suddenly costs 10x the time says so here.
     */
    heuristicScale?: number;
    expansions: number;
    tiles: number;
    loadedBytes: number;
    /** Graph blocks decoded, and the cells they came from. */
    blocks?: number;
    cells?: string[];
  };
  corridor?: Point[][];
};
export type Comparison = {
  /** The route chosen from the others, leg by leg; see `selectedRoute`. */
  selected?: RouteResult;
  reference: RouteResult;
  corridor: RouteResult;
  relativeCost: number | null;
  fieldView?: FieldView;
};
export type FieldView = {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    properties: { cost: number };
    geometry: { type: "Polygon"; coordinates: Point[][] };
  }[];
};
export type Field = {
  width: number;
  height: number;
  cellM: number;
  bbox: Graph["bbox"];
  costs: number[];
  paths: number[][];
};
