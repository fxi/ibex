/**
 * Installed-pack graph provider.
 *
 * Replaces the single-pack load in the route worker. Blocks are read by byte range from
 * each cell's graph.ibx and merged by identity — never by coordinate proximity — so a road
 * crossing a cell boundary, present in both adjacent packs, becomes one edge.
 */
import { decodeBlock } from "../offline/ibex/block";
import { decodeIndex } from "../offline/ibex/index";
import { IbexError, type BlockRef, type IbexIndex } from "../offline/ibex/spec";
import {
  isCellManifest,
  readFile as browserReadFile,
  readRange as browserReadRange,
  type Installed,
} from "../offline/store";
import { bboxIntersects, cellId, type BBox } from "../geo/grid";
import {
  COST_MODEL_VERSION,
  type Edge,
  type Graph,
  type Node,
  type Restriction,
} from "./types";

export type ProviderStats = {
  cells: string[];
  blocks: number;
  rangeReads: number;
  storedBytes: number;
  decodedBytes: number;
  duplicateEdges: number;
  seamConflicts: number;
};

type Loaded = { pack: Installed; index: IbexIndex };

/**
 * How pack bytes are obtained. The app supplies the IndexedDB/OPFS implementation; tests
 * supply one backed by the filesystem, which is what lets the whole routing core — codec,
 * merge, snapping, corridor, reference — be exercised in Node rather than a browser.
 */
export type PackReader = {
  readFile(pack: Installed, path: string): Promise<ArrayBuffer>;
  readRange(
    pack: Installed,
    path: string,
    offset: number,
    length: number,
  ): Promise<ArrayBuffer>;
};

export const browserPackReader: PackReader = {
  readFile: browserReadFile,
  readRange: browserReadRange,
};

const restrictionKey = (r: Restriction) =>
  `${r.ways.join(",")}|${r.via ?? ""}|${r.only ? 1 : 0}|${r.uTurn ? 1 : 0}`;

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class CellGraphProvider {
  private loaded: Loaded[] = [];
  private readonly cache = new Map<
    string,
    { bbox: BBox; nodes: Node[]; edges: Edge[] }
  >();
  readonly stats: ProviderStats = {
    cells: [],
    blocks: 0,
    rangeReads: 0,
    storedBytes: 0,
    decodedBytes: 0,
    duplicateEdges: 0,
    seamConflicts: 0,
  };

  constructor(
    private readonly packs: Installed[],
    readonly release: string,
    /** Published coverage, so an uninstalled cell is distinguishable from open water. */
    private readonly published: { id: string; bbox: BBox }[] = [],
    private readonly reader: PackReader = browserPackReader,
  ) {}

  /** Read every installed cell's index once; a foreign or stale pack is refused here. */
  async open(): Promise<void> {
    for (const pack of this.packs) {
      if (!isCellManifest(pack.manifest)) continue;
      if (pack.manifest.release !== this.release) continue;
      const bytes = new Uint8Array(
        await this.reader.readFile(pack, "index.ibx"),
      );
      const index = decodeIndex(bytes, {
        release: this.release,
        cell: pack.manifest.cell,
        costModelVersion: COST_MODEL_VERSION,
      });
      this.loaded.push({ pack, index });
    }
    this.loaded.sort((a, b) =>
      a.pack.manifest.id.localeCompare(b.pack.manifest.id),
    );
    this.stats.cells = this.loaded.map((l) => l.pack.manifest.id);
  }

  get installedCells(): string[] {
    return this.loaded.map((l) => l.pack.manifest.id);
  }

  /** Union of installed coverage; the merged graph's bbox. */
  envelope(): BBox | undefined {
    if (!this.loaded.length) return undefined;
    return this.loaded.reduce<BBox>(
      (acc, l) => [
        Math.min(acc[0], l.index.bbox[0]),
        Math.min(acc[1], l.index.bbox[1]),
        Math.max(acc[2], l.index.bbox[2]),
        Math.max(acc[3], l.index.bbox[3]),
      ],
      [Infinity, Infinity, -Infinity, -Infinity],
    );
  }

  contains(point: [number, number]): boolean {
    return this.loaded.some(
      (l) =>
        point[0] >= l.index.bbox[0] &&
        point[0] <= l.index.bbox[2] &&
        point[1] >= l.index.bbox[1] &&
        point[1] <= l.index.bbox[3],
    );
  }

  /** Published cells overlapping the area that are not installed. */
  missing(bbox: BBox): string[] {
    const installed = new Set(this.installedCells);
    return this.published
      .filter((c) => !installed.has(c.id) && bboxIntersects(c.bbox, bbox))
      .map((c) => c.id);
  }

  private async block(
    entry: Loaded,
    ref: BlockRef,
  ): Promise<{ nodes: Node[]; edges: Edge[] }> {
    const key = `${entry.pack.manifest.id}:${ref.x}:${ref.y}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const stored = new Uint8Array(
      await this.reader.readRange(
        entry.pack,
        "graph.ibx",
        ref.offset,
        ref.length,
      ),
    );
    this.stats.rangeReads++;
    this.stats.storedBytes += stored.length;
    const raw = await inflate(stored);
    this.stats.decodedBytes += raw.length;
    const decoded = decodeBlock(raw, entry.index.strings, {
      releaseTag: entry.index.releaseTag,
      block: { x: ref.x, y: ref.y },
      crc: ref.crc,
    });
    this.cache.set(key, { bbox: ref.bbox, ...decoded });
    this.stats.blocks++;
    return decoded;
  }

  /** Forget decoded blocks outside `bbox`, so routing leg by leg keeps memory bounded. */
  retain(bbox: BBox): void {
    for (const [key, block] of this.cache)
      if (!bboxIntersects(block.bbox, bbox)) this.cache.delete(key);
  }

  /**
   * Merge every block intersecting the area into one graph. Nodes key on OSM id and edges
   * on their deterministic id, so a boundary segment carried by two packs collapses to one.
   */
  async load(bbox: BBox): Promise<Graph> {
    const nodes = new Map<number, Node>();
    const edges = new Map<number, Edge>();
    const restrictions = new Map<string, Restriction>();

    for (const entry of this.loaded) {
      if (!bboxIntersects(entry.index.bbox, bbox)) continue;
      for (const rule of entry.index.restrictions)
        restrictions.set(restrictionKey(rule), rule);
      const refs = entry.index.blocks.filter((ref) =>
        bboxIntersects(ref.bbox, bbox),
      );
      for (const ref of refs) {
        const decoded = await this.block(entry, ref);
        for (const node of decoded.nodes)
          if (!nodes.has(node.id)) nodes.set(node.id, node);
        for (const edge of decoded.edges) {
          const existing = edges.get(edge.id);
          if (existing) {
            this.stats.duplicateEdges++;
            // Identical by construction; a difference means the two packs disagree, which
            // is worth surfacing rather than silently preferring one.
            if (existing.length !== edge.length) this.stats.seamConflicts++;
            continue;
          }
          edges.set(edge.id, edge);
        }
      }
    }

    const envelope = this.envelope();
    if (!envelope)
      throw new IbexError("cell", "No installed cells for this release");
    return {
      schemaVersion: 1,
      bbox: envelope,
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      restrictions: [...restrictions.values()],
    };
  }
}

/** Grow an anchor bbox so the corridor has room, with a floor for short requests. */
export function searchArea(anchors: [number, number][], minKm = 12): BBox {
  const bbox: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lon, lat] of anchors) {
    bbox[0] = Math.min(bbox[0], lon);
    bbox[1] = Math.min(bbox[1], lat);
    bbox[2] = Math.max(bbox[2], lon);
    bbox[3] = Math.max(bbox[3], lat);
  }
  const lat = (bbox[1] + bbox[3]) / 2;
  const padLat = Math.max(minKm / 111.32, (bbox[3] - bbox[1]) * 0.25);
  const padLon = Math.max(
    minKm / (111.32 * Math.max(0.05, Math.cos((lat * Math.PI) / 180))),
    (bbox[2] - bbox[0]) * 0.25,
  );
  return [
    bbox[0] - padLon,
    bbox[1] - padLat,
    bbox[2] + padLon,
    bbox[3] + padLat,
  ];
}

export { cellId };
