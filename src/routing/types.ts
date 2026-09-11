import type { ProfileInput } from "./profiles";
import type { RideClass } from "./eligibility";
export type { RideClass };
export const COST_MODEL_VERSION = 4;
export type Point = [number, number];
export type Profile = "gravel" | "road" | "touring" | "scenic";
export type Node = { id: number; p: Point; elevation: number | null };
export type Edge = {
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
  profile: ProfileInput;
  attraction?: Attraction;
  maxSettled?: number;
};
export type Components = {
  distance: number;
  stress: number;
  slope: number;
  surface: number;
  uncertainty: number;
  network: number;
  attraction: number;
  reward: number;
  junction: number;
  climbing: number;
  offroad: number;
  walking: number;
  countryside: number;
  cycling_network: number;
  ferry: number;
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
  /** Fractional grade, positive uphill, or null where elevation is unknown. */
  grade: number | null;
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
    explored: number;
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
