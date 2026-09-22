/**
 * One cell's routing graph, from its OSM extract.
 *
 * The orchestration half of `scripts/build_region.py`: split ways into edges at the nodes
 * that matter, score each edge, run the three bounded passes, then trim the halo and keep
 * what this cell owns.
 *
 * Elevations arrive as an argument rather than being fetched here. Sampling a DEM is I/O,
 * and keeping it out is what lets this whole module run unchanged in a worker.
 */
import { cellBBox, tileOf } from "../geo/grid";
import { distance } from "../geo/distance";
import { attractorClusters, attractorPoints } from "./attractors";
import {
  attractionSurface,
  forestSurface,
  urbanFraction,
  urbanSurface,
} from "./layers";
import { junctionSeverity, networkUtility, rewardPotential, type PassEdge } from "./passes";
import { cyclingMemberships, ferryWays, onCyclingNetwork } from "./relations";
import { roundTo } from "./round";
import { sliceProfile, structureGrade, wayProfile, type Grade } from "./terrain";
import { directions, edgeQuality, permitted, PAVED } from "./tags";
import type { CellSource } from "./osm/source";
import type { OsmTags } from "./osm/pbf";
import type { BBox } from "./surface";
import type { Point } from "../routing/types";

/**
 * Deterministic edge identity. The same physical segment must get the same id in every cell
 * that contains it, which is what lets two adjacent packs deduplicate a boundary edge
 * instead of routing over it twice. OSM way ids are below 2^31 and the API caps a way at
 * 2,000 nodes, so 12 bits of segment index is provably enough and the whole id stays inside
 * 2^53 — exactly representable as a JavaScript number, which `Edge.id` has to be.
 */
const SEGMENT_SLOTS = 4096;

export function edgeUid(wayId: number, segmentIndex: number, direction: 0 | 1): number {
  if (!(segmentIndex >= 0 && segmentIndex < SEGMENT_SLOTS))
    throw new Error(`Way ${wayId} segment index ${segmentIndex} exceeds ${SEGMENT_SLOTS} slots`);
  return (wayId * SEGMENT_SLOTS + segmentIndex) * 2 + direction;
}

/** How stressful each road class is to ride before any cycleway or surface adjustment. */
const STRESS_BY_HIGHWAY: Record<string, number> = {
  primary: 0.95,
  primary_link: 0.95,
  secondary: 0.8,
  secondary_link: 0.8,
  tertiary: 0.55,
  residential: 0.2,
  service: 0.15,
  unclassified: 0.3,
  living_street: 0.05,
  cycleway: 0.02,
};
const STRESS_DEFAULT = 0.08;
/** A cycle track alongside removes most of the road's stress. */
const SEPARATED_CYCLEWAY = new Set(["track", "separate", "protected_lane"]);
const CYCLEWAY_KEYS = ["cycleway", "cycleway:left", "cycleway:right", "cycleway:both"];
/** The tags an edge carries into the pack, beyond the ones it stores in its own fields. */
const CARRIED_TAGS = [
  "bicycle", "vehicle", "access", "foot", "route", "duration", "interval",
  "opening_hours", "seasonal", "step_count", "ramp:bicycle", "tracktype",
  "smoothness", "sac_scale", "mtb:scale", "mtb:scale:uphill", "mtb:scale:downhill",
  "incline", "width",
];
/** Barriers a bike cannot pass unless the tags say otherwise. */
const HARD_BARRIERS = new Set(["wall", "fence", "stile", "turnstile", "block"]);
const BARRIER_PERMISSIVE = new Set(["yes", "designated"]);

export type BuildEdge = {
  id: number;
  way: string;
  from: number;
  to: number;
  length: number;
  surface: string;
  highway: string;
  tags: OsmTags;
  stress: number;
  uncertainty: number;
  utility: number;
  urban: number;
  quality: number;
  forest: number;
  junction: number;
  reward: number;
  cyclingNetwork: number;
  bridge: boolean;
  tunnel: boolean;
  name: string;
  tile: string;
  geometry: Point[];
  grades: Grade[] | null;
  ferryService?: string;
  ferrySeconds?: number;
};

export type BuildNode = { id: number; p: Point; elevation: number | null };
export type Restriction = { ways: string[]; only: boolean; uTurn: boolean; via?: number };
export type Graph = {
  schemaVersion: 1;
  bbox: number[];
  nodes: BuildNode[];
  edges: BuildEdge[];
  restrictions: Restriction[];
};

export type Cell = { zoom: number; x: number; y: number };
export type BuildOptions = {
  /** Omit to keep the whole extract, as a region build does. */
  cell?: Cell;
  /** Node id to metres. Absent nodes fall back to the way's incline tag, then to nothing. */
  elevations?: ReadonlyMap<number, number>;
  haloKm?: number;
  metresPerPixel?: number;
};

export type BuildResult = { graph: Graph; counts: Record<string, number> };

const HALO_KM = 5.0;

/** Longitude degrees shorten with latitude; use the worst of the box's two edges. */
function haloDegrees(bbox: BBox, haloKm: number): [number, number] {
  const worst = Math.max(Math.abs(bbox[1]), Math.abs(bbox[3]));
  return [
    haloKm / (111.32 * Math.max(0.05, Math.cos((worst * Math.PI) / 180))),
    haloKm / 111.32,
  ];
}

/**
 * The bounds a cell must be built from: its own, grown by the halo.
 *
 * `extract_cells.py` cut one pbf per cell on exactly this box. A builder reading a whole
 * country instead subsets to it, so both paths see the same ground.
 */
export function sourceBBox(cell: Cell, haloKm: number = HALO_KM): BBox {
  const bbox = cellBBox(cell);
  const [dx, dy] = haloDegrees(bbox, haloKm);
  return [bbox[0] - dx, bbox[1] - dy, bbox[2] + dx, bbox[3] + dy];
}

export function buildGraph(source: CellSource, options: BuildOptions = {}): BuildResult {
  const { cell, elevations = new Map<number, number>(), haloKm = HALO_KM } = options;
  const counts: Record<string, number> = {
    excludedWays: 0,
    waysMissingPositions: 0,
    stepsSegments: 0,
    ferrySegments: 0,
    restrictionsOutsideGraph: 0,
  };

  // A ferry's tags come from its relation, and it becomes a road class of its own so the
  // rest of the build treats it like any other way.
  const ferries = ferryWays(source);
  const tagsOf = (id: number, tags: OsmTags): OsmTags => {
    const ferry = ferries.get(id);
    return ferry ? { ...ferry.tags, highway: "ferry" } : tags;
  };

  const networks = cyclingMemberships(source);

  const extent: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const node of source.nodes) {
    if (node.lon < extent[0]) extent[0] = node.lon;
    if (node.lat < extent[1]) extent[1] = node.lat;
    if (node.lon > extent[2]) extent[2] = node.lon;
    if (node.lat > extent[3]) extent[3] = node.lat;
  }
  for (const way of source.ways)
    for (const ref of way.refs) {
      const p = source.positions.get(ref);
      if (!p) continue;
      if (p[0] < extent[0]) extent[0] = p[0];
      if (p[1] < extent[1]) extent[1] = p[1];
      if (p[0] > extent[2]) extent[2] = p[0];
      if (p[1] > extent[3]) extent[3] = p[1];
    }
  const bbox: BBox = Number.isFinite(extent[0]) ? extent : [0, 0, 0, 0];

  /**
   * Surfaces cover the cell and its halo, not the whole extract.
   *
   * A `complete_ways` extract holds every node of any way that touches the cell, so one
   * long ferry route or a cross-country relation stretches the extract's bounds hundreds of
   * kilometres. Rasterising that is enormous and pointless: nothing outside the halo is ever
   * sampled, because every edge the cell keeps starts inside it.
   */
  const surfaceBox: BBox = [...bbox];
  if (cell) {
    const bounds = cellBBox(cell);
    const [lon, lat] = haloDegrees(bounds as BBox, haloKm);
    surfaceBox[0] = Math.max(bbox[0], bounds[0] - lon);
    surfaceBox[1] = Math.max(bbox[1], bounds[1] - lat);
    surfaceBox[2] = Math.min(bbox[2], bounds[2] + lon);
    surfaceBox[3] = Math.min(bbox[3], bounds[3] + lat);
  }

  const urban = urbanSurface(source, surfaceBox, options.metresPerPixel);
  const forest = forestSurface(source, surfaceBox, options.metresPerPixel);
  const clusters = attractorClusters(attractorPoints(source.nodes));
  counts.attractors = clusters.length;
  const attraction = attractionSurface(clusters, surfaceBox, options.metresPerPixel);

  const barriers = new Map<number, OsmTags>();
  for (const node of source.nodes) if ("barrier" in node.tags) barriers.set(node.id, node.tags);
  const blocked = new Set<number>();
  for (const [id, tags] of barriers)
    if (
      !permitted({ highway: "path", ...tags }) ||
      (HARD_BARRIERS.has(tags.barrier ?? "") && !BARRIER_PERMISSIVE.has(tags.bicycle ?? ""))
    )
      blocked.add(id);

  // Conservatively remove from-ways for unsupported conditional restrictions.
  const conditionalFrom = new Set<number>();
  for (const relation of source.relations)
    if (Object.keys(relation.tags).some((key) => key.includes("conditional")))
      for (const member of relation.members)
        if (member.role === "from") conditionalFrom.add(member.ref);

  const candidates = source.ways
    .map((way) => ({ way, tags: tagsOf(way.id, way.tags) }))
    .filter(({ way, tags }) => "highway" in tags && way.refs.length > 0);
  const roads = candidates.filter(
    ({ way, tags }) => permitted(tags) && !conditionalFrom.has(way.id),
  );
  counts.excludedWays = candidates.length - roads.length;

  // Positions and usage come from road ways alone: the split rule asks how many *roads*
  // share a node, and a node shared with a river is not a junction.
  const positions = new Map<number, Point>();
  const usage = new Map<number, number>();
  for (const { way } of roads)
    for (const ref of way.refs) {
      const p = source.positions.get(ref);
      if (!p) continue;
      positions.set(ref, p);
      usage.set(ref, (usage.get(ref) ?? 0) + 1);
    }

  const { restrictions, viaNodes } = readRestrictions(source, roads, counts);

  /**
   * Where ways are cut into edges: a way's endpoints, a barrier, a restriction's via node,
   * and any node two roads share. Derived from this extract alone — `complete_ways` puts
   * every road touching a node inside the cell and halo into it, so the answer here is the
   * answer a whole-region pass would give (see docs/issues.md B5).
   */
  const kept = new Set<number>(viaNodes);
  for (const id of barriers.keys()) kept.add(id);
  for (const { way } of roads) {
    kept.add(way.refs[0]);
    kept.add(way.refs[way.refs.length - 1]);
  }
  for (const [id, count] of usage) if (count > 1) kept.add(id);

  const edges: BuildEdge[] = [];
  const nodeIds = new Set<number>();

  for (const { way, tags } of roads) {
    const sequence = way.refs;
    // One unresolved node discards the whole way, including the parts that are located.
    if (sequence.some((id) => !positions.has(id))) {
      counts.waysMissingPositions++;
      continue;
    }
    const highway = tags.highway!;
    const bridge = (tags.bridge ?? "no") !== "no";
    const tunnel = (tags.tunnel ?? "no") !== "no";
    // A structure is never sampled from the DEM: it sees the valley below a bridge and the
    // mountain above a tunnel. One tagged-or-flat grade serves every segment.
    const structure = bridge || tunnel ? structureGrade(tags.incline) : undefined;
    const { offsets, samples } = wayProfile(sequence, positions, elevations, tags.incline);

    let start = 0;
    for (let i = 1; i < sequence.length; i++) {
      if (!kept.has(sequence[i]) && i < sequence.length - 1) continue;
      const ids = sequence.slice(start, i + 1);
      const profileStart = offsets[start];
      const profileEnd = offsets[i];
      // Index of the segment's first node within the way, not a running counter, so the id
      // does not depend on where the previous cut fell.
      const segmentIndex = start;
      start = i;
      if (ids.some((id) => blocked.has(id))) continue;
      const coords = ids.map((id) => positions.get(id)!);
      let length = 0;
      for (let k = 0; k + 1 < coords.length; k++) length += distance(coords[k], coords[k + 1]);
      if (length < 0.1) continue;

      const gradeSamples: Grade[] | null =
        highway === "ferry"
          ? null
          : bridge || tunnel
            ? structure === undefined
              ? null
              : [[roundTo(length, 3), roundTo(structure, 5)]]
            : (sliceProfile(samples, profileStart, profileEnd) ?? null);
      const estimated = gradeSamples === null || bridge || tunnel;

      let stress = STRESS_BY_HIGHWAY[highway] ?? STRESS_DEFAULT;
      if (CYCLEWAY_KEYS.some((key) => SEPARATED_CYCLEWAY.has(tags[key] ?? ""))) stress *= 0.35;
      const raw = tags.surface ?? "unknown";
      const surface = PAVED.has(raw) ? "paved" : raw;
      const uncertainty = Math.min(
        1,
        (surface === "unknown" ? 0.55 : 0.1) +
          (estimated ? 0.15 : 0) +
          ((highway === "path" || highway === "track") && !("bicycle" in tags) ? 0.15 : 0),
      );

      const carried: OsmTags = {};
      for (const key of CARRIED_TAGS) if (key in tags) carried[key] = tags[key];

      const base = {
        way: String(way.id),
        length: roundTo(length, 2),
        surface,
        highway,
        tags: carried,
        stress: roundTo(stress, 3),
        uncertainty: roundTo(uncertainty, 3),
        utility: 0,
        urban: roundTo(urbanFraction(coords, tags, urban), 3),
        quality: edgeQuality(highway, surface, tags, stress),
        forest: roundTo(forest.sampleLine(coords), 3),
        bridge,
        tunnel,
        name: tags.name ?? "",
        tile: `${Math.floor(coords[0][0] * 20)}_${Math.floor(coords[0][1] * 20)}`,
        junction: 0,
        reward: 0,
      };

      let ferryService: string | undefined;
      let ferrySeconds: number | undefined;
      if (highway === "ferry") {
        const ferry = ferries.get(way.id)!;
        ferryService = ferry.source;
        if (ferry.seconds !== undefined && offsets[offsets.length - 1] > 0)
          ferrySeconds = roundTo((ferry.seconds * length) / offsets[offsets.length - 1], 3);
        base.stress = 0;
        base.uncertainty = ferry.seconds !== undefined ? 0.1 : 0.4;
        counts.ferrySegments++;
      }
      if (highway === "steps") counts.stepsSegments++;

      const [forward, backward] = directions(tags);
      if (forward)
        edges.push({
          ...base,
          id: edgeUid(way.id, segmentIndex, 0),
          cyclingNetwork: onCyclingNetwork({ ...way, tags }, "forward", networks),
          from: ids[0],
          to: ids[ids.length - 1],
          geometry: coords,
          grades: gradeSamples,
          ...(ferryService === undefined ? {} : { ferryService }),
          ...(ferrySeconds === undefined ? {} : { ferrySeconds }),
        });
      if (backward)
        edges.push({
          ...base,
          id: edgeUid(way.id, segmentIndex, 1),
          cyclingNetwork: onCyclingNetwork({ ...way, tags }, "backward", networks),
          from: ids[ids.length - 1],
          to: ids[0],
          geometry: [...coords].reverse(),
          grades: gradeSamples
            ? [...gradeSamples].reverse().map(([metres, grade]): Grade => [metres, -grade])
            : null,
          ...(ferryService === undefined ? {} : { ferryService }),
          ...(ferrySeconds === undefined ? {} : { ferrySeconds }),
        });
      nodeIds.add(ids[0]);
      nodeIds.add(ids[ids.length - 1]);
    }
  }

  const passEdges = edges as unknown as PassEdge[];
  const utility = networkUtility(passEdges, nodeIds);
  for (const edge of edges) edge.utility = utility.get(edge.to) ?? 0;
  const junction = junctionSeverity(passEdges, nodeIds);
  for (const edge of edges) edge.junction = junction.get(edge.to) ?? 0;
  const reward = rewardPotential(passEdges, attraction);
  for (const edge of edges) edge.reward = reward.get(edge.to) ?? 0;

  const trimmed = cell ? trimToCell(edges, cell, haloKm, counts) : edges;
  const keptNodes = new Set<number>();
  for (const edge of trimmed) {
    keptNodes.add(edge.from);
    keptNodes.add(edge.to);
  }
  const presentWays = new Set(trimmed.map((edge) => edge.way));
  const keptRestrictions = cell
    ? restrictions.filter((rule) => rule.ways.every((w) => presentWays.has(w)))
    : restrictions;

  const graphBBox = cell ? [...cellBBox(cell)] : [...bbox];
  const nodes: BuildNode[] = [...keptNodes]
    .sort((a, b) => a - b)
    .map((id) => ({
      id,
      p: positions.get(id)!,
      elevation: elevations.has(id) ? roundTo(elevations.get(id)!, 2) : null,
    }));

  counts.nodes = nodes.length;
  counts.edges = trimmed.length;
  counts.restrictions = keptRestrictions.length;
  counts.cyclingNetworkEdges = trimmed.filter((e) => e.cyclingNetwork > 0).length;
  counts.urbanEdges = trimmed.filter((e) => e.urban > 0).length;

  return {
    graph: {
      schemaVersion: 1,
      bbox: graphBBox,
      nodes,
      edges: trimmed,
      restrictions: keptRestrictions,
    },
    counts,
  };
}

/**
 * Keep the edges this cell owns, and record how far past its halo they reach.
 *
 * Ownership is the cell containing an edge's *first* geometry point — a property of the road
 * itself, so adjacent cells agree without consulting each other.
 */
function trimToCell(
  edges: BuildEdge[],
  cell: Cell,
  haloKm: number,
  counts: Record<string, number>,
): BuildEdge[] {
  const owned = edges.filter((edge) => {
    const tile = tileOf(edge.geometry[0], cell.zoom);
    return tile.x === cell.x && tile.y === cell.y;
  });
  const bounds = cellBBox(cell);
  const [haloLon, haloLat] = haloDegrees(bounds as BBox, haloKm);

  let overshoot = 0;
  let roadOvershoot = 0;
  let beyond = 0;
  for (const edge of owned) {
    let far = false;
    for (const p of edge.geometry) {
      const out = Math.max(bounds[0] - p[0], p[0] - bounds[2], bounds[1] - p[1], p[1] - bounds[3]);
      if (out > overshoot) overshoot = out;
      // Scheduled ferries legitimately run hundreds of km, so only roads are held to the
      // limits that judge whether the extract is sound.
      if (edge.highway !== "ferry" && out > roadOvershoot) roadOvershoot = out;
      if (
        !far &&
        !(
          bounds[0] - haloLon <= p[0] &&
          p[0] <= bounds[2] + haloLon &&
          bounds[1] - haloLat <= p[1] &&
          p[1] <= bounds[3] + haloLat
        )
      ) {
        far = true;
        beyond++;
      }
    }
  }
  counts.haloOvershootKm = roundTo(Math.max(0, overshoot) * 111.32, 3);
  counts.roadOvershootKm = roundTo(Math.max(0, roadOvershoot) * 111.32, 3);
  counts.haloEdgesDropped = edges.length - owned.length;
  counts.edgesBeyondHalo = beyond;
  if (counts.roadOvershootKm > 200)
    throw new Error(
      `Cell ${cell.zoom}-${cell.x}-${cell.y} owns a road reaching ` +
        `${counts.roadOvershootKm.toFixed(2)} km past its bounds; the extract is wrong`,
    );
  return owned;
}

/** Turn restrictions a bicycle must obey, and the via nodes they pin. */
function readRestrictions(
  source: CellSource,
  roads: { way: { id: number } }[],
  counts: Record<string, number>,
): { restrictions: Restriction[]; viaNodes: Set<number> } {
  const roadIds = new Set(roads.map(({ way }) => way.id));
  const restrictions: Restriction[] = [];
  const viaNodes = new Set<number>();

  for (const relation of source.relations) {
    const tags = relation.tags;
    if (tags.type !== "restriction") continue;
    // An exception naming bicycles means the rule is not ours to obey.
    if ((tags.except ?? "").split(";").includes("bicycle")) continue;
    const kind = tags["restriction:bicycle"] ?? tags.restriction ?? "";
    if (!kind.startsWith("no_") && !kind.startsWith("only_")) continue;

    const starts = relation.members.filter((m) => m.role === "from" && m.type === "way");
    const ends = relation.members.filter((m) => m.role === "to" && m.type === "way");
    const via = relation.members.filter((m) => m.role === "via");
    if (starts.length === 0 || ends.length === 0) continue;

    for (const from of starts)
      for (const to of ends) {
        const sequence = [
          from.ref,
          ...via.filter((m) => m.type === "way").map((m) => m.ref),
          to.ref,
        ];
        if (!sequence.every((id) => roadIds.has(id))) {
          counts.restrictionsOutsideGraph++;
          continue;
        }
        const rule: Restriction = {
          ways: sequence.map(String),
          only: kind.startsWith("only_"),
          uTurn: kind.endsWith("u_turn"),
        };
        const nodeVia = via.filter((m) => m.type === "node");
        if (nodeVia.length > 0) {
          rule.via = nodeVia[0].ref;
          viaNodes.add(nodeVia[0].ref);
        }
        restrictions.push(rule);
      }
  }
  return { restrictions, viaNodes };
}
