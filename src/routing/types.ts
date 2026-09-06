export type Point = [number, number];
export type Profile = "gravel" | "road" | "touring";
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
  stress: number;
  uncertainty: number;
  utility: number;
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
  profile: Profile;
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
};
export type RouteStatus =
  "ok" | "outside-coverage" | "snap-failed" | "no-path" | "budget-exceeded";
export type RouteResult = {
  status: RouteStatus;
  mode: "reference" | "corridor";
  geometry: Point[];
  anchors: Point[];
  cost: number;
  components: Components;
  distanceM: number;
  ascentM: number | null;
  descentM: number | null;
  elevationProfile: [number, number | null][];
  edgeIds: number[];
  surfaceM: Record<string, number>;
  uncertainM: number;
  metrics: {
    durationMs: number;
    explored: number;
    expansions: number;
    tiles: number;
    loadedBytes: number;
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
