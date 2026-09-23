/**
 * One z13 graph block: independently decodable, addressed by byte range from the cell index.
 *
 * Every scale in spec.ts matches the rounding the pipeline already applies, so encode and
 * decode are exactly lossless — round-trip tests assert equality, not a tolerance.
 */
import { ByteReader, ByteWriter, crc32 } from "./varint";
import {
  BLOCK_MAGIC,
  COORD_SCALE,
  DecodedBlock,
  ELEVATION_SCALE,
  FERRY_SECONDS_SCALE,
  FLAG,
  DATA_VERSION,
  GRADE_LENGTH_SCALE,
  GRADE_SCALE,
  IbexError,
  LENGTH_SCALE,
  MAX_BLOCK_EDGES,
  MAX_BLOCK_NODES,
  UNIT_SCALE,
} from "./spec";
import type { Edge, Node, Point } from "../../routing/types";
import { edgeSignals } from "../../routing/signals";

const SEMANTIC_SCALE = 1_000_000;
const SEMANTIC_FIELDS = [
  "roughness",
  "technicalUp",
  "technicalDown",
  "unpaved",
  "curvature",
] as const;

const fixed = (value: number, scale: number) => Math.round(value * scale);

export type StringTable = {
  index(value: string): number;
  values(): string[];
};

export function stringTable(existing: string[] = []): StringTable {
  const values = [...existing];
  const lookup = new Map(values.map((v, i) => [v, i]));
  return {
    index(value: string) {
      let at = lookup.get(value);
      if (at === undefined) {
        at = values.length;
        values.push(value);
        lookup.set(value, at);
      }
      return at;
    },
    values: () => values,
  };
}

/** Nodes referenced by these edges, sorted by id — the block's own coordinate table. */
function nodeTable(nodes: Node[], edges: Edge[]): Node[] {
  const wanted = new Set<number>();
  for (const edge of edges) {
    wanted.add(edge.from);
    wanted.add(edge.to);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const table: Node[] = [];
  for (const id of [...wanted].sort((a, b) => a - b)) {
    const node = byId.get(id);
    if (!node)
      throw new Error(`Block references node ${id} with no coordinates`);
    table.push(node);
  }
  return table;
}

export function encodeBlock(
  block: { x: number; y: number },
  nodes: Node[],
  edges: Edge[],
  strings: StringTable,
  releaseTag: number,
): Uint8Array {
  const table = nodeTable(nodes, edges);
  if (table.length > MAX_BLOCK_NODES || edges.length > MAX_BLOCK_EDGES)
    throw new IbexError("limits", "Block exceeds the node or edge cap");
  const position = new Map(table.map((n, i) => [n.id, i]));
  const ordered = [...edges].sort((a, b) => a.id - b.id);

  const w = new ByteWriter(1 << 16);
  w.u32(BLOCK_MAGIC);
  w.u16(DATA_VERSION);
  w.u16(0);
  w.u32(releaseTag);
  w.varint(block.x);
  w.varint(block.y);

  w.varint(table.length);
  let previousId = 0,
    previousLon = 0,
    previousLat = 0,
    previousElevation = 0;
  for (const node of table) {
    w.varint(node.id - previousId);
    previousId = node.id;
    const lon = fixed(node.p[0], COORD_SCALE),
      lat = fixed(node.p[1], COORD_SCALE);
    w.zigzag(lon - previousLon);
    w.zigzag(lat - previousLat);
    previousLon = lon;
    previousLat = lat;
    if (node.elevation === null || node.elevation === undefined) w.byte(0);
    else {
      w.byte(1);
      const cm = fixed(node.elevation, ELEVATION_SCALE);
      w.zigzag(cm - previousElevation);
      previousElevation = cm;
    }
  }

  w.varint(ordered.length);
  let previousEdgeId = 0;
  let previous: Edge | undefined;
  for (const edge of ordered) {
    // Forward and backward records of one segment are adjacent because direction is the
    // low bit of the id, so the reverse record can inherit almost everything.
    const mirror =
      previous !== undefined &&
      edge.id === previous.id + 1 &&
      previous.id % 2 === 0 &&
      edge.from === previous.to &&
      edge.to === previous.from;

    w.varint(edge.id - previousEdgeId);
    previousEdgeId = edge.id;

    let flags = 0;
    if (mirror) flags |= FLAG.mirrorPrevious;
    if (!mirror) {
      if (edge.bridge) flags |= FLAG.bridge;
      if (edge.tunnel) flags |= FLAG.tunnel;
      if (edge.grades) flags |= FLAG.hasGrades;
      if (edge.tags) flags |= FLAG.hasTags;
      if (edge.ferrySeconds !== undefined) flags |= FLAG.hasFerrySeconds;
      if (edge.name) flags |= FLAG.hasName;
      if (edge.ferryService !== undefined) flags |= FLAG.hasFerryService;
      if (edge.quality !== undefined) flags |= FLAG.hasQuality;
      if (edge.forest !== undefined) flags |= FLAG.hasForest;
    }
    w.u16(flags);

    // Direction-dependent regardless of mirroring; measured on real data.
    w.varint(fixed(edge.utility, UNIT_SCALE));
    w.varint(fixed(edge.cyclingNetwork ?? 0, UNIT_SCALE));
    w.varint(fixed(edge.junction ?? 0, UNIT_SCALE));
    w.varint(fixed(edge.reward ?? 0, UNIT_SCALE));
    // Riding signals are precomputed once here rather than per edge per search.
    const signals = edgeSignals(edge);
    for (const field of SEMANTIC_FIELDS)
      w.varint(fixed(signals[field], SEMANTIC_SCALE));
    w.byte(signals.surfaceKnown ? 1 : 0);

    if (mirror) {
      previous = edge;
      continue;
    }

    const from = position.get(edge.from),
      to = position.get(edge.to);
    if (from === undefined || to === undefined)
      throw new Error(`Edge ${edge.id} references a node outside its block`);
    w.varint(from);
    w.varint(to);
    w.varint(fixed(edge.length, LENGTH_SCALE));

    // The first and last points are the endpoint nodes, so only interior points are stored.
    const interior = edge.geometry.slice(1, -1);
    w.varint(interior.length);
    let lon = fixed(edge.geometry[0][0], COORD_SCALE),
      lat = fixed(edge.geometry[0][1], COORD_SCALE);
    for (const point of interior) {
      const px = fixed(point[0], COORD_SCALE),
        py = fixed(point[1], COORD_SCALE);
      w.zigzag(px - lon);
      w.zigzag(py - lat);
      lon = px;
      lat = py;
    }

    w.varint(strings.index(edge.surface));
    w.varint(strings.index(edge.highway));
    if (flags & FLAG.hasName) w.varint(strings.index(edge.name));
    if (flags & FLAG.hasFerryService)
      w.varint(strings.index(edge.ferryService as string));

    w.varint(fixed(edge.stress, UNIT_SCALE));
    w.varint(fixed(edge.uncertainty, UNIT_SCALE));
    w.varint(fixed(edge.urban ?? 0, UNIT_SCALE));
    if (flags & FLAG.hasQuality)
      w.varint(fixed(edge.quality as number, UNIT_SCALE));
    if (flags & FLAG.hasForest)
      w.varint(fixed(edge.forest as number, UNIT_SCALE));

    if (flags & FLAG.hasTags) {
      const entries = Object.entries(edge.tags as Record<string, string>);
      w.varint(entries.length);
      for (const [key, value] of entries) {
        w.varint(strings.index(key));
        w.varint(strings.index(value));
      }
    }
    if (flags & FLAG.hasGrades) {
      const grades = edge.grades as [number, number][];
      w.varint(grades.length);
      for (const [meters, grade] of grades) {
        w.varint(fixed(meters, GRADE_LENGTH_SCALE));
        w.zigzag(fixed(grade, GRADE_SCALE));
      }
    }
    if (flags & FLAG.hasFerrySeconds)
      w.varint(fixed(edge.ferrySeconds as number, FERRY_SECONDS_SCALE));

    previous = edge;
  }
  return w.finish();
}

type BlockOptions = {
  releaseTag: number;
  block?: { x: number; y: number };
  crc?: number;
};

/** A block's header and node table, read; its edge records follow at `r`. */
function openBlock(data: Uint8Array, strings: string[], options: BlockOptions) {
  if (options.crc !== undefined && crc32(data) !== options.crc)
    throw new IbexError("digest", "Block failed its checksum");
  const r = new ByteReader(data);
  if (r.u32() !== BLOCK_MAGIC)
    throw new IbexError("magic", "Not an Ibex block");
  const version = r.u16();
  if (version !== DATA_VERSION)
    throw new IbexError("version", `Unsupported block version ${version}`);
  r.u16();
  if (r.u32() !== options.releaseTag)
    throw new IbexError("release", "Block belongs to another data release");
  const x = r.varint(),
    y = r.varint();
  if (options.block && (x !== options.block.x || y !== options.block.y))
    throw new IbexError("cell", `Block ${x}/${y} is not the block requested`);
  const tile = `13-${x}-${y}`;

  const nodeCount = r.varint();
  if (nodeCount > MAX_BLOCK_NODES)
    throw new IbexError("limits", "Block declares too many nodes");
  const nodes: Node[] = [];
  let id = 0,
    lon = 0,
    lat = 0,
    elevation = 0;
  for (let i = 0; i < nodeCount; i++) {
    id += r.varint();
    lon += r.zigzag();
    lat += r.zigzag();
    let value: number | null = null;
    if (r.byte()) {
      elevation += r.zigzag();
      value = elevation / ELEVATION_SCALE;
    }
    nodes.push({
      id,
      p: [lon / COORD_SCALE, lat / COORD_SCALE],
      elevation: value,
    });
  }

  const edgeCount = r.varint();
  if (edgeCount > MAX_BLOCK_EDGES)
    throw new IbexError("limits", "Block declares too many edges");
  const text = (at: number) => {
    const value = strings[at];
    if (value === undefined)
      throw new IbexError("bounds", `String ${at} is outside the dictionary`);
    return value;
  };
  return { r, tile, nodes, edgeCount, text };
}

type RecordContext = {
  tile: string;
  text: (at: number) => string;
  node: (local: number) => Node | undefined;
};

/**
 * One edge record, after its id delta. A mirrored record inherits from `previous`, the
 * record before it; `ends` receives the node-table indices either way.
 */
function readEdgeRecord(
  r: ByteReader,
  ctx: RecordContext,
  edgeId: number,
  previous: Edge | undefined,
  ends?: { from: number; to: number; mirror: boolean },
): Edge {
  const { text } = ctx;
  const flags = r.u16();
  const utility = r.varint() / UNIT_SCALE;
  const cyclingNetwork = r.varint() / UNIT_SCALE;
  const junction = r.varint() / UNIT_SCALE;
  const reward = r.varint() / UNIT_SCALE;
  const values = SEMANTIC_FIELDS.map(() => r.varint() / SEMANTIC_SCALE);
  const known = r.byte();
  if (values.some((value) => value < 0 || value > 1) || known > 1)
    throw new IbexError("field", "Invalid precomputed riding signals");
  const semantics: Edge["semantics"] = {
    version: 1,
    roughness: values[0],
    technicalUp: values[1],
    technicalDown: values[2],
    unpaved: values[3],
    curvature: values[4],
    surfaceKnown: known === 1,
  };

  if (flags & FLAG.mirrorPrevious) {
    const source = previous;
    if (!source)
      throw new IbexError("bounds", "Mirrored edge has no predecessor");
    if (ends) ends.mirror = true;
    return {
      ...source,
      id: edgeId,
      way: String(Math.floor(edgeId / 8192)),
      from: source.to,
      to: source.from,
      geometry: [...source.geometry].reverse(),
      grades: source.grades
        ? [...source.grades]
            .reverse()
            .map(([m, g]) => [m, -g] as [number, number])
        : null,
      utility,
      cyclingNetwork,
      junction,
      reward,
      semantics,
    };
  }

  const fromIndex = r.varint(),
    toIndex = r.varint();
  const from = ctx.node(fromIndex),
    to = ctx.node(toIndex);
  if (!from || !to)
    throw new IbexError("bounds", `Edge ${edgeId} references a missing node`);
  if (ends) {
    ends.from = fromIndex;
    ends.to = toIndex;
    ends.mirror = false;
  }
  const length = r.varint() / LENGTH_SCALE;
  const interior = r.varint();
  const geometry: Point[] = [from.p];
  let px = Math.round(from.p[0] * COORD_SCALE),
    py = Math.round(from.p[1] * COORD_SCALE);
  for (let k = 0; k < interior; k++) {
    px += r.zigzag();
    py += r.zigzag();
    geometry.push([px / COORD_SCALE, py / COORD_SCALE]);
  }
  geometry.push(to.p);

  const surface = text(r.varint());
  const highway = text(r.varint());
  const name = flags & FLAG.hasName ? text(r.varint()) : "";
  const ferryService =
    flags & FLAG.hasFerryService ? text(r.varint()) : undefined;
  const stress = r.varint() / UNIT_SCALE;
  const uncertainty = r.varint() / UNIT_SCALE;
  const urban = r.varint() / UNIT_SCALE;
  const quality = flags & FLAG.hasQuality ? r.varint() / UNIT_SCALE : undefined;
  const forest = flags & FLAG.hasForest ? r.varint() / UNIT_SCALE : undefined;

  let tags: Record<string, string> | undefined;
  if (flags & FLAG.hasTags) {
    const count = r.varint();
    tags = {};
    for (let k = 0; k < count; k++) tags[text(r.varint())] = text(r.varint());
  }
  let grades: [number, number][] | null = null;
  if (flags & FLAG.hasGrades) {
    const count = r.varint();
    grades = [];
    for (let k = 0; k < count; k++)
      grades.push([r.varint() / GRADE_LENGTH_SCALE, r.zigzag() / GRADE_SCALE]);
  }
  const ferrySeconds =
    flags & FLAG.hasFerrySeconds ? r.varint() / FERRY_SECONDS_SCALE : undefined;

  const edge: Edge = {
    semantics,
    id: edgeId,
    from: from.id,
    to: to.id,
    way: String(Math.floor(edgeId / 8192)),
    length,
    geometry,
    grades,
    surface,
    highway,
    stress,
    uncertainty,
    utility,
    urban,
    bridge: Boolean(flags & FLAG.bridge),
    tunnel: Boolean(flags & FLAG.tunnel),
    name,
    tile: ctx.tile,
    cyclingNetwork,
    junction,
    reward,
  };
  if (quality !== undefined) edge.quality = quality;
  if (forest !== undefined) edge.forest = forest;
  if (tags) edge.tags = tags;
  if (ferryService !== undefined) edge.ferryService = ferryService;
  if (ferrySeconds !== undefined) edge.ferrySeconds = ferrySeconds;
  return edge;
}

export function decodeBlock(
  data: Uint8Array,
  strings: string[],
  options: BlockOptions,
): DecodedBlock {
  const { r, tile, nodes, edgeCount, text } = openBlock(data, strings, options);
  const ctx: RecordContext = { tile, text, node: (i) => nodes[i] };
  const edges: Edge[] = [];
  let edgeId = 0;
  for (let i = 0; i < edgeCount; i++) {
    edgeId += r.varint();
    edges.push(readEdgeRecord(r, ctx, edgeId, edges[edges.length - 1]));
  }
  return { nodes, edges };
}

/**
 * A block kept as its own bytes, with just enough indexed to decode any one edge again.
 *
 * Decoded, an edge is an object of some twenty fields with an array per vertex and per
 * grade run, about 1.5 KB; a 100 km leg holds over a million of them, which is several
 * times what a phone lets a tab keep. The record itself is about 65 bytes. So a block is
 * decoded once, checked, and kept as bytes plus a few columns; `blockEdge` rebuilds any
 * edge from its offset, identical to what `decodeBlock` returns for it.
 */
export type CompactBlock = {
  bytes: Uint8Array;
  strings: string[];
  tile: string;
  nodeId: Float64Array;
  lon: Float64Array;
  lat: Float64Array;
  /** NaN where the node has no elevation. */
  elevation: Float64Array;
  edgeId: Float64Array;
  /** Where each record starts, after its id delta. */
  offset: Int32Array;
  /** The record a mirrored edge inherits from, or -1. */
  source: Int32Array;
  /** Node-table indices of each edge's ends. */
  from: Int32Array;
  to: Int32Array;
};

export function compactBlock(
  data: Uint8Array,
  strings: string[],
  options: BlockOptions,
  check: { node(node: Node): void; edge(edge: Edge): void } = {
    node() {},
    edge() {},
  },
): CompactBlock {
  const { r, tile, nodes, edgeCount, text } = openBlock(data, strings, options);
  const ctx: RecordContext = { tile, text, node: (i) => nodes[i] };
  const n = nodes.length;
  const block: CompactBlock = {
    bytes: data,
    strings,
    tile,
    nodeId: new Float64Array(n),
    lon: new Float64Array(n),
    lat: new Float64Array(n),
    elevation: new Float64Array(n),
    edgeId: new Float64Array(edgeCount),
    offset: new Int32Array(edgeCount),
    source: new Int32Array(edgeCount),
    from: new Int32Array(edgeCount),
    to: new Int32Array(edgeCount),
  };
  for (let i = 0; i < n; i++) {
    const node = nodes[i];
    check.node(node);
    block.nodeId[i] = node.id;
    block.lon[i] = node.p[0];
    block.lat[i] = node.p[1];
    block.elevation[i] = node.elevation ?? NaN;
  }
  const ends = { from: 0, to: 0, mirror: false };
  let edgeId = 0,
    previous: Edge | undefined;
  for (let i = 0; i < edgeCount; i++) {
    edgeId += r.varint();
    block.edgeId[i] = edgeId;
    block.offset[i] = r.position;
    previous = readEdgeRecord(r, ctx, edgeId, previous, ends);
    check.edge(previous);
    if (ends.mirror) {
      block.source[i] = i - 1;
      block.from[i] = block.to[i - 1];
      block.to[i] = block.from[i - 1];
    } else {
      block.source[i] = -1;
      block.from[i] = ends.from;
      block.to[i] = ends.to;
    }
  }
  return block;
}

/** Edge `i` of a compact block, decoded again from its record. */
export function blockEdge(block: CompactBlock, i: number): Edge {
  const node = (local: number): Node | undefined =>
    local < block.nodeId.length
      ? {
          id: block.nodeId[local],
          p: [block.lon[local], block.lat[local]],
          elevation: Number.isNaN(block.elevation[local])
            ? null
            : block.elevation[local],
        }
      : undefined;
  const ctx: RecordContext = {
    tile: block.tile,
    // Every string was resolved once when the block was compacted.
    text: (at) => block.strings[at],
    node,
  };
  const r = new ByteReader(block.bytes);
  const source = block.source[i];
  const previous =
    source === -1 ? undefined : blockEdge(block, source);
  return readEdgeRecord(
    r.seek(block.offset[i]),
    ctx,
    block.edgeId[i],
    previous,
  );
}
